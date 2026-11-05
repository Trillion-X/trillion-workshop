"""Find, in every candidate track, the window whose loudness arc best fits a film's music brief.

The brief (BRIEF.json, film seconds: {arc: [[second, dB], ...], length_s, open: [from, to], lift: [from, to], swell: [from, to]}),
for example a calm open, a build, a lift, a held middle, a warm swell and a resolve, is written as DATA (ARC) and compared with each window's smoothed loudness curve
(Pearson correlation of dB curves) plus measured constraints (open below the lift, swell near the top).

Writes OUT/music/windows.json and one WAV excerpt per track (its best window) to OUT/music/excerpts/; the last line printed is {"result": {...}}.
Usage: python -I find_music_windows.py BRIEF.json OUT <track>...
"""
import json
import os
import subprocess
import sys

import numpy as np

SR = 22050
HOP = 0.25
LEN = None                 # the brief's window length (BRIEF.json, argv)
ROOT = None                # OUT (argv)
ARC = OPEN = LIFT = SWELL = None   # the brief's arc and its open, lift and swell spans (BRIEF.json)


def decode(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def env_db(x):
    n = int(SR * HOP)
    frames = len(x) // n
    rms = np.sqrt(np.mean(x[:frames * n].reshape(frames, n) ** 2, axis=1) + 1e-12)
    k = int(2.0 / HOP)
    sm = np.convolve(rms, np.ones(k) / k, mode='same')
    return 20 * np.log10(sm + 1e-9)


def target():
    t = np.arange(0, LEN, HOP)
    xs, ys = zip(*ARC)
    return np.interp(t, xs, ys)


def score(w, tgt):
    c = float(np.corrcoef(w, tgt)[0, 1])

    def i(s):
        return int(s / HOP)

    open_db = float(np.mean(w[i(OPEN[0]):i(OPEN[1])]))
    lift_db = float(np.mean(w[i(LIFT[0]):i(LIFT[1])]))
    swell_db = float(np.max(w[i(SWELL[0]):i(SWELL[1])]))
    top = float(np.max(w))
    floor = float(np.min(w))
    s = c
    s += 0.15 * np.clip((lift_db - open_db) / 6.0, -1, 1)   # the lift stands above the open
    s -= 0.15 * np.clip((top - swell_db) / 6.0, 0, 1)        # the swell reaches near the top
    s -= 0.5 * (floor < -45)                                  # no dropouts / fade-outs inside the window
    return s, dict(corr=round(c, 3), open_db=round(open_db, 1), lift_db=round(lift_db, 1),
                   swell_db=round(swell_db, 1), lift_over_open_db=round(lift_db - open_db, 1),
                   window_range_db=round(top - floor, 1))


def main(paths):
    tgt = target()
    n = len(tgt)
    out = []
    os.makedirs(os.path.join(ROOT, 'music', 'excerpts'), exist_ok=True)
    for p in paths:
        x = decode(p)
        e = env_db(x)
        best = None
        for s0 in range(0, max(1, len(e) - n), int(1.0 / HOP)):
            w = e[s0:s0 + n]
            if len(w) < n:
                break
            sc, info = score(w, tgt)
            if best is None or sc > best[0]:
                best = (sc, s0 * HOP, info)
        sc, start, info = best
        name = os.path.splitext(os.path.basename(p))[0]
        exc = os.path.join(ROOT, 'music', 'excerpts', f'{name}@{start:.0f}.wav')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{start:.3f}', '-t', f'{LEN}', '-i', p,
                        '-ar', '48000', '-ac', '2', exc], check=True)
        out.append(dict(track=os.path.abspath(p), name=name, start_s=start, end_s=start + LEN,
                        arc_score=round(sc, 3), excerpt=exc, **info))
        print(f'{name:48s} start {start:6.1f}s  score {sc:+.3f}  {info}', file=sys.stderr, flush=True)
    out.sort(key=lambda r: -r['arc_score'])
    with open(os.path.join(ROOT, 'music', 'windows.json'), 'w') as fh:
        json.dump(dict(arc=ARC, hop_s=HOP, length_s=LEN, windows=out), fh, indent=1)


if __name__ == '__main__':
    with open(sys.argv[1]) as fh:
        brief = json.load(fh)
    ARC, LEN, OPEN, LIFT, SWELL = [tuple(p) for p in brief['arc']], brief['length_s'], brief['open'], brief['lift'], brief['swell']
    ROOT = sys.argv[2]
    main(sys.argv[3:])
    print(json.dumps({'result': {'windows': os.path.join(ROOT, 'music', 'windows.json'), 'tracks': len(sys.argv[3:])}}))
