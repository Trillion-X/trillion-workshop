# computer/speak-with-mlx.py
#
# Purpose: say words out loud with a speech model on this computer's own chip (mlx-audio), so Trillion speaks in a
# natural voice, the person's own cloned voice or a neutral one, and nobody pays for it. It is the program of the
# `engines` rows of computer/speak.json, run by computer/speak.mjs (tool:speak and tool:make-a-voice):
#
#   python3 speak-with-mlx.py serve <socket> <idle_seconds>   keeps models loaded and answers one JSON line per request
#   python3 speak-with-mlx.py once                            answers the one JSON request read from standard input
#
# A request is one of:
#   { "say": { text, model, takes, speaker?, lang_code?, reference?, reference_text?, out, loudness } }
#   (always at the voice's natural pace: the speed a person sets is applied by whoever plays the sound)
#       -> { out, seconds, sample_rate, took_seconds, first_sound_seconds, peak }
#   { "reference": { recording, out, hear_model, window, fade_seconds } }
#       -> { out, text, start, end, seconds }
#
# Invariants:
#   1. Nothing leaves this computer: the model runs here, the sound is written to `out`, the answer is printed.
#   2. A cloned voice is only ever made from a reference that ends where a sentence ends, with a pause after it, and
#      whose words are exactly what is said in it (`reference` picks that window from any recording, heard with
#      mlx-whisper's word timings). A reference cut mid-sentence makes the model say its last words again before the
#      text ("Going ...", measured 2026-10-07 with Qwen3-TTS and F5-TTS alike), so no other kind is made here.
#   3. The sound is brought to one loudness (`loudness.rms_dbfs`, never above `loudness.peak`): cloned voices come
#      out about 9 dB quieter than neutral ones, and a peak above full scale would clip (crackle).
#   4. One model of each kind is loaded once per server and kept until it has been idle `idle_seconds`, so a second
#      sentence starts at once instead of waiting for the model to load again. One server per socket: a second one
#      started while the first answers ends at once (computer/resident.py, the one serving loop of every model
#      program on this computer).
#
# AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import json
import sys
import time

import numpy as np
import soundfile as sf

from resident import serve

MODELS = {}


def model(name):
    if name not in MODELS:
        from mlx_audio.tts.utils import load_model
        MODELS[name] = load_model(name)
    return MODELS[name]


def level(audio, loudness):
    rms = float(np.sqrt(np.mean(audio ** 2))) if audio.size else 0.0
    if rms <= 1e-6:
        return audio
    gain = 10 ** (loudness['rms_dbfs'] / 20) / rms
    peak = float(np.abs(audio).max()) * gain
    if peak > loudness['peak']:
        gain *= loudness['peak'] / peak
    return (audio * gain).astype(np.float32)


def say(request):
    started = time.time()
    tts = model(request['model'])
    kwargs = {}
    if request['takes'] == 'reference':
        kwargs.update(ref_audio=request['reference'], ref_text=request['reference_text'])
    else:
        kwargs.update(voice=request['speaker'], lang_code=request.get('lang_code', 'a'))
    first = None
    parts = []
    for result in tts.generate(request['text'], **kwargs):
        if first is None:
            first = time.time() - started
        parts.append(np.array(result.audio, dtype=np.float32).reshape(-1))
    if not parts:
        raise ValueError('the model made no sound')
    audio = level(np.concatenate(parts), request['loudness'])
    rate = int(tts.sample_rate)
    sf.write(request['out'], audio, rate, subtype='PCM_16')
    return {'out': request['out'], 'seconds': round(len(audio) / rate, 3), 'sample_rate': rate,
            'took_seconds': round(time.time() - started, 3), 'first_sound_seconds': round(first, 3),
            'peak': round(float(np.abs(audio).max()), 3)}


def reference(request):
    import mlx_whisper
    heard = mlx_whisper.transcribe(request['recording'], path_or_hf_repo=request['hear_model'], word_timestamps=True,
                                   condition_on_previous_text=False)
    words = [word for segment in heard['segments'] for word in segment.get('words', [])]
    audio, rate = sf.read(request['recording'], dtype='float32', always_2d=True)
    audio = audio.mean(axis=1)
    length_of_recording = len(audio) / rate
    window = request['window']
    best = None
    for i, word in enumerate(words):
        before = word['start'] - (words[i - 1]['end'] if i else 0.0)
        if i and before < window['pause_before_seconds']:
            continue
        for j in range(i, len(words)):
            length = words[j]['end'] - word['start']
            if length > window['longest_seconds']:
                break
            after = (words[j + 1]['start'] if j + 1 < len(words) else length_of_recording) - words[j]['end']
            last = words[j]['word'].strip()
            ends_sentence = last[-1:] in window['sentence_ends'] and not any(last.endswith(trail) for trail in window['trailing_off'])
            if length >= window['shortest_seconds'] and ends_sentence and after >= window['pause_after_seconds']:
                score = abs(length - window['best_seconds'])
                if best is None or score < best[0]:
                    best = (score, i, j)
    if best is None:
        raise ValueError('no stretch of this recording ends where a sentence ends with a pause after it')
    _, i, j = best
    fade = request['fade_seconds']
    start = max(0.0, words[i]['start'] - fade)
    next_start = words[j + 1]['start'] if j + 1 < len(words) else length_of_recording
    end = min(length_of_recording, words[j]['end'] + fade * 4, (words[j]['end'] + next_start) / 2)
    cut = audio[int(start * rate):int(end * rate)].copy()
    edge = max(1, int(fade * rate))
    cut[:edge] *= np.linspace(0, 1, edge, dtype=np.float32)
    cut[-edge:] *= np.linspace(1, 0, edge, dtype=np.float32)
    sf.write(request['out'], cut, rate, subtype='PCM_16')
    text = ''.join(word['word'] for word in words[i:j + 1]).strip()
    return {'out': request['out'], 'text': text, 'start': round(start, 3), 'end': round(end, 3), 'seconds': round(end - start, 3)}


def answer(request):
    try:
        if 'say' in request:
            return {'ok': True, **say(request['say'])}
        if 'reference' in request:
            return {'ok': True, **reference(request['reference'])}
        return {'ok': False, 'error': 'the request asks for neither say nor reference'}
    except Exception as error:  # every failure goes back as words, so the caller falls back to its next voice
        return {'ok': False, 'error': str(error) or type(error).__name__}


if __name__ == '__main__':
    if sys.argv[1] == 'serve':
        serve(sys.argv[2], float(sys.argv[3]), answer)
    else:
        json.dump(answer(json.loads(sys.stdin.read())), sys.stdout)
