# computer/hear-with-bark.py
#
# Purpose: hear one English recording on this Mac with Underdog Bark 3.0 (Conway Research, CC-BY-4.0, a post-trained and
# compressed NVIDIA Parakeet TDT 0.6B v3) on the Mac's own chip through mlx-audio, and print the words as the same JSON
# transcript value hear-with-mlx-whisper.py prints:
#   { text, segments: [{ start, end, text, words: [{ word, start, end }] }], language: "en", heard_whole: true }
# It is the first `hearing` row in computer-sources.json; keep-drive-files.mjs hearWith runs it and passes a recording
# on to the next row (mlx-whisper) when it is not English or asks for words this model cannot take.
#
#   python3 hear-with-bark.py prepare <model> <progress file>
#       the one-time preparation (the row's `prepare`, started ahead of the first recording by keep-drive-files.mjs
#       prepareHearing): <model> is "<Hugging Face repository>@<revision>"; model.bark and its mlx/ files are fetched at
#       that pinned revision and unpacked into ~/.trillion/hearing/bark/<revision> (UNPACKED below), writing its progress
#       as one JSON object to <progress file>: { model, label, state: fetching | unpacking | ready | failed, done, total,
#       percent, error?, pid, started_at, updated_at }.
#   python3 hear-with-bark.py <recording> <model> [<language> [<prompt> [<detect_model>]]]
#       hears one recording with a prepared model; one not prepared is refused (never fetched inside a hearing), so
#       hearWith hands the recording to the next hearing row.
#       <language> is the language already heard; empty, <detect_model> (a Whisper model) finds it from the first 30 s.
#   python3 hear-with-bark.py serve <socket> <idle_seconds>
#       stays running with the model loaded (computer/resident.py), as hear-with-mlx-whisper.py does.
#
# Invariants:
#   1. Read only: the recording is read in place; the only writes are preparation's fetched and unpacked files and its
#      progress file. A hearing never fetches or unpacks: the 163 MB fetch and the unpacking (96 s on a busy M5 Max)
#      happen once, in preparation, before the first recording that needs them.
#   2. English only (the model's card: "English only"). A recording in another language is not heard here: the answer
#      is { "passed_on": true, "language": <the language found> }, and hearWith hears it with the next hearing row.
#   3. A prompt (words that may come up, computer/dictation.mjs biasPrompt) cannot steer this model, so hearWith never
#      sends one here (the row's "prompt": false); it goes to a row that takes it.
#   4. Unpacking is exact (the format's own decoder, ported from the model's bark_loader.py and bark_mlx.py) and
#      streams: each tensor is decoded, renamed to mlx-audio's layout and kept as FP16 before the next, never the
#      whole model as FP32 (measured 2026-10-21: 4.7 GB resident at most for a first run that fetched, unpacked,
#      found the language and heard a 17.5-minute meeting, against 6.7 GB for the card's loader to unpack alone).
#   5. Sound is heard PIECE_SECONDS at a time with OVERLAP_SECONDS between pieces (mlx-audio merges the overlap):
#      in one pass the model's memory grows with the length of the recording (the card: a 10-minute file peaked at
#      about 15 GB), in pieces it stays flat (measured 3.3 GB at 120 s pieces for a 17.5-minute meeting).
#   6. Every word keeps its own seconds from the start of the recording, from the model's token timings.
#
# Attribution (CC-BY-4.0, https://creativecommons.org/licenses/by/4.0/): Underdog Bark 3.0 by Conway Research
# (https://huggingface.co/ConwayResearch/Underdog-Bark-3.0), derived from nvidia/parakeet-tdt-0.6b-v3 (c) NVIDIA
# Corporation and moondream/parakeet-ultra (c) Moondream, both CC-BY-4.0; post-trained and compressed by Conway Research.
# The unpacking below is adapted from that repository's bark_loader.py and bark_mlx.py.
#
# AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import json
import lzma
import os
import re
import sys

import numpy as np

from resident import answer_argv, serve

UNPACKED = os.path.expanduser('~/.trillion/hearing/bark')
FETCHED = ['mlx/config.json', 'mlx/tokenizer.model', 'mlx/tokenizer.vocab', 'mlx/vocab.txt', 'model.bark']
FETCH_FROM = 'https://huggingface.co/{repository}/resolve/{revision}/{name}'
FETCH_CHUNK_BYTES = 1 << 20
LANGUAGES = ('en',)
SAMPLE_RATE = 16000
LEADING_SILENCE_SECONDS = 0.25
PIECE_SECONDS = 120.0
OVERLAP_SECONDS = 5.0
DETECT_SECONDS = 30
COLUMN_CLASSES = 16

_RENAMES = [
    (r"encoder\.subsampling\.layers\.", "encoder.pre_encode.conv."), (r"encoder\.subsampling\.linear\.", "encoder.pre_encode.out."),
    (r"\.conv\.norm\.", ".conv.batch_norm."), (r"\.q_proj\.", ".linear_q."), (r"\.k_proj\.", ".linear_k."),
    (r"\.v_proj\.", ".linear_v."), (r"\.o_proj\.", ".linear_out."), (r"\.relative_k_proj\.", ".linear_pos."),
    (r"\.bias_u$", ".pos_bias_u"), (r"\.bias_v$", ".pos_bias_v"), (r"^decoder\.embedding\.", "decoder.prediction.embed."),
    (r"^encoder_projector\.", "joint.enc."), (r"^decoder\.decoder_projector\.", "joint.pred."), (r"^joint\.head\.", "joint.joint_net.2."),
]


def _codes(classes, counts, words, rows, cols):
    import constriction
    coder = constriction.stream.stack.AnsCoder(words)
    codes = np.empty((rows, cols), np.uint8)
    for column_class in range(len(counts)):
        index = np.nonzero(classes == column_class)[0]
        model = constriction.stream.model.Categorical(counts[column_class] / counts[column_class].sum(), perfect=False)
        codes[:, index] = coder.decode(model, rows * len(index)).reshape(len(index), rows).T
    return codes


def _weights(levels, codes):
    k = levels.shape[1]
    levels = levels.astype(np.float32)
    magnitude = np.where(codes == 0, 0, np.where(codes <= k, codes, codes - k)).astype(np.int64)
    value = np.take_along_axis(np.concatenate([np.zeros((levels.shape[0], 1), np.float32), levels], 1), magnitude, 1)
    return np.where(codes > k, -value, value)


def _tensors(path):
    """(how many tensors, each (name, float32 array) of a .bark file ("bark-levels-v2" or "-v3") one at a time, decoded exactly)."""
    raw = open(path, 'rb').read()
    size = int.from_bytes(raw[:8], 'little')
    head = json.loads(raw[8:8 + size])
    if head['format'] not in ('bark-levels-v2', 'bark-levels-v3'):
        raise ValueError(f"{path} is a {head['format']} file, not a Bark 3.0 model")
    return len(head['index']), _decoded(raw, head, 8 + size)


def _decoded(raw, head, at):
    import constriction
    unz = lambda blob, flag: lzma.decompress(blob) if flag else blob
    for entry in head['index']:
        shape = entry['shape']
        if entry['k'] == 'levels2':
            k, rows, cols = entry['K'], shape[0], int(np.prod(shape[1:]))
            levels = np.frombuffer(unz(raw[at:at + entry['lev']], entry.get('zl')), np.float16).reshape(rows, k); at += entry['lev']
            meta = raw[at:at + entry['meta']]; at += entry['meta']
            packed = (cols * 4 + 7) // 8
            bits = np.unpackbits(np.frombuffer(meta[:packed], np.uint8))[:cols * 4].reshape(cols, 4)
            classes = np.packbits(np.concatenate([np.zeros((cols, 4), np.uint8), bits], 1), axis=1)[:, 0]
            counts = np.frombuffer(meta[packed:], np.uint32).reshape(COLUMN_CLASSES, 2 * k + 1).astype(np.float64)
            words = np.frombuffer(raw[at:at + entry['b']], np.uint32).copy(); at += entry['b']
            yield entry['n'], _weights(levels, _codes(classes, counts, words, rows, cols)).reshape(shape)
        elif entry['k'].startswith('ansint'):
            bits = int(entry['k'][6:])
            scale = np.frombuffer(unz(raw[at:at + entry['s']], entry.get('zs')), np.float16).astype(np.float32); at += entry['s']
            counts = np.frombuffer(raw[at:at + entry['meta']], np.uint32).astype(np.float64); at += entry['meta']
            words = np.frombuffer(raw[at:at + entry['b']], np.uint32).copy(); at += entry['b']
            model = constriction.stream.model.Categorical(counts / counts.sum(), perfect=False)
            symbols = constriction.stream.stack.AnsCoder(words).decode(model, int(np.prod(shape)))
            q = (symbols - (2 ** (bits - 1) - 1)).astype(np.float32)
            yield entry['n'], (q.reshape(len(scale), -1) * scale[:, None]).reshape(shape)
        elif entry['k'] == 'raw':
            dtype = {'torch.int64': np.int64, 'torch.int32': np.int32}.get(entry['dtype'], np.float16)
            yield entry['n'], np.frombuffer(unz(raw[at:at + entry['b']], entry.get('zr')), dtype).copy().reshape(shape); at += entry['b']
        else:
            raise ValueError(f"unknown tensor kind {entry['k']}")


def _unpack(bark_file, folder, step=lambda done, total: None):
    """model.bark -> an mlx-audio Parakeet folder of FP16 weights, tensor by tensor (invariant 4); step(done, total) after each."""
    import mlx.core as mx
    weights, lstm_bias = {}, {}
    total, tensors = _tensors(bark_file)
    for done, (name, value) in enumerate(tensors, 1):
        step(done, total)
        if name.endswith('num_batches_tracked') or name.startswith('vad_head'):
            continue
        value = np.asarray(value, np.float32)
        lstm = re.match(r"decoder\.lstm\.(weight_ih|weight_hh|bias_ih|bias_hh)_l(\d)", name)
        if lstm:
            kind, layer = lstm.groups()
            base = f"decoder.prediction.dec_rnn.lstm.{layer}"
            if kind.startswith('bias'):
                lstm_bias[f"{base}.bias"] = lstm_bias.get(f"{base}.bias", 0) + value
            else:
                weights[f"{base}.{'Wx' if kind == 'weight_ih' else 'Wh'}"] = mx.array(value).astype(mx.float16)
            continue
        if re.search(r"encoder\.subsampling\.layers\.\d+\.weight$", name):
            value = value.transpose(0, 2, 3, 1)
        if re.search(r"conv\.(depthwise_conv|pointwise_conv[12])\.weight$", name):
            value = value.transpose(0, 2, 1)
        for pattern, replacement in _RENAMES:
            name = re.sub(pattern, replacement, name)
        weights[name] = mx.array(value).astype(mx.float16)
    weights.update({name: mx.array(value).astype(mx.float16) for name, value in lstm_bias.items()})
    mx.save_safetensors(f"{folder}/model.partial.safetensors", weights)
    os.replace(f"{folder}/model.partial.safetensors", f"{folder}/model.safetensors")


def _where(model):
    """(repository, revision, unpacked folder) of `model` ("<repository>@<revision>")."""
    repository, _, revision = model.partition('@')
    if not revision or not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError(f"{model} names no pinned revision: a Bark model is fetched only at a pinned commit")
    return repository, revision, os.path.join(UNPACKED, revision)


def _folder(model):
    """The unpacked folder of a prepared `model`; one not prepared is refused (invariant 1)."""
    folder = _where(model)[2]
    if not os.path.exists(f"{folder}/model.safetensors"):
        raise RuntimeError('Underdog Bark 3.0 is not prepared on this Mac yet; it is prepared once before it hears.')
    return folder


def prepare(model, progress, label='Preparing Underdog Bark 3.0'):
    """Fetches and unpacks `model` once, writing what it is doing to `progress` (JSON) as it goes."""
    import urllib.request
    from datetime import datetime, timezone
    stamp = lambda: datetime.now(timezone.utc).isoformat(timespec='seconds')
    repository, revision, folder = _where(model)
    started = stamp()
    os.makedirs(os.path.dirname(progress), mode=0o700, exist_ok=True)

    def say(state, done=0, total=0, **more):
        value = {'model': model, 'label': label, 'state': state, 'done': done, 'total': total,
                 'percent': round(100 * done / total, 1) if total else (100.0 if state == 'ready' else 0.0),
                 'pid': os.getpid(), 'started_at': started, 'updated_at': stamp(), **more}
        with open(f"{progress}.partial", 'w') as out:
            json.dump(value, out)
        os.replace(f"{progress}.partial", progress)
        return value

    try:
        if os.path.exists(f"{folder}/model.safetensors"):
            return say('ready')
        fetched = os.path.join(folder, 'fetched')
        os.makedirs(fetched, mode=0o700, exist_ok=True)
        for name in FETCHED:
            target = os.path.join(fetched, os.path.basename(name))
            with urllib.request.urlopen(FETCH_FROM.format(repository=repository, revision=revision, name=name), timeout=60) as answer:
                total = int(answer.headers.get('content-length') or 0)
                done = 0
                with open(f"{target}.partial", 'wb') as out:
                    while chunk := answer.read(FETCH_CHUNK_BYTES):
                        out.write(chunk)
                        done += len(chunk)
                        if name == 'model.bark':
                            say('fetching', done, total)
                if total and done != total:
                    raise IOError(f"{name} arrived with {done} of {total} bytes")
            os.replace(f"{target}.partial", target)
        for name in FETCHED[:-1]:
            os.replace(os.path.join(fetched, os.path.basename(name)), os.path.join(folder, os.path.basename(name)))
        _unpack(os.path.join(fetched, 'model.bark'), folder, lambda done, total: say('unpacking', done, total))
        os.remove(os.path.join(fetched, 'model.bark'))
        os.rmdir(fetched)
        return say('ready')
    except BaseException as error:
        say('failed', error=str(error) or type(error).__name__)
        raise


_LOADED = {}


def _model(model):
    if model not in _LOADED:
        import mlx.core as mx
        from mlx_audio.stt import load
        loaded = load(_folder(model), strict=True, model_type='parakeet')
        mx.eval(loaded.parameters())
        _LOADED[model] = loaded
    return _LOADED[model]


def _wave(recording):
    """The recording as mono 16 kHz float32 samples, decoded by ffmpeg exactly as mlx-whisper decodes it, so any audio
    or video the mlx-whisper row hears is heard here too (mlx-audio's own reader takes only WAV, MP3, FLAC and Vorbis)."""
    from mlx_whisper.audio import load_audio
    return np.asarray(load_audio(recording, SAMPLE_RATE), np.float32)


def detect(wave, detect_model):
    """The language spoken in the first DETECT_SECONDS of `wave`, by a Whisper model's language guess."""
    import mlx.core as mx
    from mlx_whisper.audio import N_FRAMES, N_SAMPLES, log_mel_spectrogram, pad_or_trim
    from mlx_whisper.load_models import load_model
    if detect_model not in _LOADED:
        _LOADED[detect_model] = load_model(detect_model, dtype=mx.float16)
    whisper = _LOADED[detect_model]
    mel = log_mel_spectrogram(wave[:DETECT_SECONDS * SAMPLE_RATE], n_mels=whisper.dims.n_mels, padding=N_SAMPLES)
    _, probabilities = whisper.detect_language(pad_or_trim(mel, N_FRAMES, axis=-2).astype(mx.float16))
    return max(probabilities, key=probabilities.get)


def _words(tokens):
    """Tokens (each with its own seconds) joined into words: a token starting with a space starts a word."""
    words = []
    for token in tokens:
        if not words or token.text.startswith(' '):
            words.append({'word': token.text, 'start': token.start, 'end': token.end})
        else:
            words[-1]['word'] += token.text
            words[-1]['end'] = token.end
    return [word for word in words if word['word'].strip()]


def hear(recording, model, language='', prompt='', detect_model=''):
    if prompt:
        raise ValueError('Bark cannot take words that may come up; hear this recording with a row that takes a prompt')
    wave = _wave(recording)
    found = language or (detect(wave, detect_model) if detect_model else '')
    if found not in LANGUAGES:
        return {'passed_on': True, 'language': found}
    import mlx.core as mx
    padding = int(LEADING_SILENCE_SECONDS * SAMPLE_RATE)
    heard = _model(model).generate(mx.array(np.concatenate([np.zeros(padding, np.float32), wave])), dtype=mx.bfloat16,
                                   chunk_duration=PIECE_SECONDS, overlap_duration=OVERLAP_SECONDS, verbose=False)
    segments = []
    for sentence in heard.sentences:
        words = [{**word, 'start': max(0.0, word['start'] - LEADING_SILENCE_SECONDS), 'end': max(0.0, word['end'] - LEADING_SILENCE_SECONDS)} for word in _words(sentence.tokens)]
        if words:
            segments.append({'start': words[0]['start'], 'end': words[-1]['end'], 'text': sentence.text.strip(), 'words': words})
    mx.clear_cache()
    return {'text': ' '.join(segment['text'] for segment in segments).strip(), 'segments': segments, 'language': 'en', 'heard_whole': True}


def main(argv):
    if argv and argv[0] == 'prepare':
        return prepare(*argv[1:4])
    return hear(*(list(argv) + [''] * (5 - len(argv)))[:5])


if __name__ == '__main__':
    if sys.argv[1] == 'serve':
        serve(sys.argv[2], float(sys.argv[3]), answer_argv(main))
    else:
        json.dump(main(sys.argv[1:]), sys.stdout)
