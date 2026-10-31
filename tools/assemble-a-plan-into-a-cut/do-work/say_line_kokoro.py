"""Say one line with a Kokoro voice on this computer (mlx-audio), trimmed to its words with a soft end and a little room tone.

usage: python3 say_line_kokoro.py --text-file <line.txt> --out <take.wav> --voice <kokoro voice> --lang <kokoro lang code>
         [--model mlx-community/Kokoro-82M-bf16] [--room-db -62] [--room-before 0.25] [--room-after 0.1]

A speaker for the voice-lines step (voice.say). The silence before and after the words is cut at --trim-db (keeping --head
seconds before the first loud frame and 0.06 s after the last), the end is cut --tail seconds after the last frame above
--end-db and faded over --fade seconds, and room tone (brown noise at --room-db) is laid before and after so the line does not
start or end on digital silence. Writes 24-bit PCM at the model's rate. Needs mlx-audio (Apple Silicon) and numpy, soundfile.
"""
import argparse

import numpy as np
import soundfile as sf


def trim(y, sr, db, head):
    win = int(0.01 * sr)
    env = 20 * np.log10(np.sqrt(np.convolve(y ** 2, np.ones(win) / win, mode='same')) + 1e-9)
    loud = np.where(env > db)[0]
    return y[max(0, loud[0] - int(head * sr)):loud[-1] + int(0.06 * sr)] if len(loud) else y


def soft_end(y, sr, db, tail, fade):
    win = int(0.01 * sr)
    env = 20 * np.log10(np.sqrt(np.convolve(y ** 2, np.ones(win) / win, mode='same')) + 1e-9)
    loud = np.where(env > db)[0]
    y = y[:min(len(y), loud[-1] + int(tail * sr))].copy() if len(loud) else y.copy()
    k = min(int(fade * sr), len(y))
    y[-k:] *= 0.5 * (1 + np.cos(np.linspace(0, np.pi, k)))
    return y


def room(rng, sr, seconds, db):
    n = rng.standard_normal(int(seconds * sr)).cumsum()
    n -= np.linspace(n[0], n[-1], len(n))
    return n / (np.abs(n).max() + 1e-9) * 10 ** (db / 20)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--text-file', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--voice', required=True)
    ap.add_argument('--lang', required=True)
    ap.add_argument('--model', default='mlx-community/Kokoro-82M-bf16')
    ap.add_argument('--trim-db', type=float, default=-55.0)
    ap.add_argument('--head', type=float, default=0.08)
    ap.add_argument('--end-db', type=float, default=-50.0)
    ap.add_argument('--tail', type=float, default=0.12)
    ap.add_argument('--fade', type=float, default=0.09)
    ap.add_argument('--room-db', type=float, default=-62.0)
    ap.add_argument('--room-before', type=float, default=0.25)
    ap.add_argument('--room-after', type=float, default=0.1)
    ap.add_argument('--seed', type=int, default=7)
    a = ap.parse_args()
    from mlx_audio.tts.utils import load_model
    model = load_model(a.model)
    sr = model.sample_rate
    text = open(a.text_file).read()
    y = np.concatenate([np.array(r.audio, dtype=np.float32).reshape(-1) for r in model.generate(text=text, voice=a.voice, lang_code=a.lang)])
    rng = np.random.default_rng(a.seed)
    body = soft_end(trim(y, sr, a.trim_db, a.head), sr, a.end_db, a.tail, a.fade)
    sf.write(a.out, np.concatenate([room(rng, sr, a.room_before, a.room_db), body, room(rng, sr, a.room_after, a.room_db)]), sr, subtype='PCM_24')


if __name__ == '__main__':
    main()
