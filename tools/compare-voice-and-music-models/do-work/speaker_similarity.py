"""Speaker similarity of each line to a cloned voice's reference recording, with the WeSpeaker ResNet34 speaker model
(cosine of 256-number voice embeddings; same-speaker pairs typically score well above 0.5). Use it to compare the lines
two or more voice models said: one folder of lines per model.

usage: python3 -I speaker_similarity.py <reference wav> <dir> [<dir> ...] [--pattern '*.wav'] [--model <hub id>]

Needs ffmpeg, torch and pyannote.audio. The model is read from the local Hugging Face cache (HF_HUB_OFFLINE=1 unless
set); run once with HF_HUB_OFFLINE=0 to fetch it. Prints one line per folder (each line's score and the mean) and a
last line {"result": {...}} or {"error": "what to change"}.
"""
import argparse, glob, json, os, subprocess, sys, warnings

MODEL = 'pyannote/wespeaker-voxceleb-resnet34-LM'


class Refusal(Exception):
    pass


def wav_files(folder, pattern):
    return sorted(glob.glob(os.path.join(glob.escape(folder), pattern)))


def score(ref, embeddings):
    """{name: cosine to ref} for unit vectors, and their mean (None when there are none)."""
    import numpy as np
    sims = {name: float(np.dot(v, ref)) for name, v in embeddings.items()}
    return sims, (float(np.mean(list(sims.values()))) if sims else None)


def main(argv):
    p = argparse.ArgumentParser(description='Score how alike each line sounds to a reference voice.')
    p.add_argument('reference')
    p.add_argument('dirs', nargs='+')
    p.add_argument('--pattern', default='*.wav')
    p.add_argument('--model', default=MODEL)
    a = p.parse_args(argv)
    try:
        if not os.path.isfile(a.reference):
            raise Refusal(f'{a.reference} is not there: pass the recording the voice was cloned from')
        for d in a.dirs:
            if not os.path.isdir(d):
                raise Refusal(f'{d} is not a folder: pass one folder of line recordings per voice model')
        os.environ.setdefault('HF_HUB_OFFLINE', '1'); warnings.filterwarnings('ignore')
        try:
            import numpy as np, torch
            from pyannote.audio import Inference, Model
        except ImportError as e:
            raise Refusal(f'needs torch and pyannote.audio ({e.name} is missing): python3 -m pip install -U torch pyannote.audio')
    except Refusal as e:
        print(json.dumps({'error': str(e)}))
        return 2
    inf = Inference(Model.from_pretrained(a.model), window='whole')

    def emb(p):
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'], check=True, capture_output=True).stdout
        x = np.frombuffer(raw, dtype=np.float32).copy()
        v = np.asarray(inf({'waveform': torch.from_numpy(x).unsqueeze(0), 'sample_rate': 16000})).ravel()
        return v / np.linalg.norm(v)

    ref = emb(a.reference)
    folders = []
    for d in a.dirs:
        sims, mean = score(ref, {os.path.basename(f): emb(f) for f in wav_files(d, a.pattern)})
        shown = f'{mean:.3f}' if mean is not None else 'n.a. (no files match)'
        print(d, ' '.join(f'{k} {v:.3f}' for k, v in sims.items()), f'| mean {shown}')
        folders.append({'dir': d, 'lines': {k: round(v, 3) for k, v in sims.items()}, 'mean': None if mean is None else round(mean, 3)})
    print(json.dumps({'result': {'reference': a.reference, 'model': a.model, 'folders': folders}}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
