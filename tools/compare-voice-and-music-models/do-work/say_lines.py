"""Evaluation only: say lines in a candidate text-to-speech model, cloned from a reference recording, so they can be
compared with the same lines from the voice already in use (for example by speaker_similarity.py, or by listening).

usage: python -I say_lines.py <model id> <out dir> <ref wav> <ref text> <line id>=<text> [<line id>=<text> ...]

The model is any voice-cloning model mlx-audio loads (Apple silicon), e.g. a Fish Speech S2 Pro conversion. Read the
model's licence before using what it says: some (the Fish Audio Research License among them) allow non-commercial
evaluation only. Writes <out dir>/<line id>.wav (24-bit, the model's sample rate) per line, prints a timing line per
line, and a last line {"result": {...}} or {"error": "what to change"}.
"""
import json, pathlib, sys, time


class Refusal(Exception):
    pass


def parse_lines(args):
    """[(line id, text)] from <line id>=<text> arguments."""
    lines = []
    for arg in args:
        lid, eq, text = arg.partition('=')
        if not eq or not lid or not text.strip():
            raise Refusal(f'{arg!r} is not <line id>=<text>: give each line as an id, an equals sign and the words')
        if '/' in lid or lid in ('.', '..'):
            raise Refusal(f'line id {lid!r} names a file in the out dir: use letters, digits, - and _')
        lines.append((lid, text))
    return lines


def main(argv):
    try:
        if len(argv) < 5:
            raise Refusal('pass <model id> <out dir> <ref wav> <ref text> and at least one <line id>=<text>')
        model_id, out, ref, ref_text = argv[:4]
        lines = parse_lines(argv[4:])
        if not pathlib.Path(ref).is_file():
            raise Refusal(f'{ref} is not there: pass the reference recording the voice is cloned from')
        try:
            import numpy as np, soundfile as sf
            from mlx_audio.tts.utils import load_model
            from mlx_audio.utils import load_audio
        except ImportError as e:
            raise Refusal(f'needs mlx-audio, numpy and soundfile ({e.name} is missing): python3 -m pip install -U mlx-audio numpy soundfile, on Apple silicon')
    except Refusal as e:
        print(json.dumps({'error': str(e)}))
        return 2
    out = pathlib.Path(out); out.mkdir(parents=True, exist_ok=True)
    t = time.time(); model = load_model(model_id); print(f'load {time.time() - t:.1f} s', flush=True)
    ref = load_audio(ref, sample_rate=model.sample_rate)
    said = []
    for lid, text in lines:
        t = time.time()
        segs = list(model.generate(text=text, ref_audio=ref, ref_text=ref_text, verbose=False))
        audio = np.concatenate([np.array(s.audio, dtype=np.float32) for s in segs])
        sf.write(out / f'{lid}.wav', audio, model.sample_rate, subtype='PCM_24')
        seconds, took = len(audio) / model.sample_rate, time.time() - t
        print(f'{lid}: {seconds:.2f} s audio in {took:.1f} s ({model.sample_rate} Hz)', flush=True)
        said.append({'line': lid, 'wav': str(out / f'{lid}.wav'), 'seconds': round(seconds, 2), 'took': round(took, 1)})
    print(json.dumps({'result': {'model': model_id, 'sample_rate': model.sample_rate, 'lines': said}}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
