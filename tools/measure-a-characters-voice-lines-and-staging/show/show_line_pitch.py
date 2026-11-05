"""Caption lines with the median stored window pitch (from an .emb.npz), for hand-labelling who speaks.
usage: python3 -I line_pitch.py <id> <start> <end>"""
import os, sys, glob, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lines import events
import hf_speaker as H
vid, a, b = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
d = np.load(os.path.join(H.VOICE, vid + '.emb.npz')); t, f = d['t'], d['f0']
fs = [x for dd in ('captions', 'videos') for x in sorted(glob.glob(os.path.join(H.HOME, 'library', 'youtube', dd, vid + '.en*.json3')))]
ev = events(fs[0])
for i, (s, du, x) in enumerate(ev):
    if not a <= s <= b: continue
    e = ev[i + 1][0] if i + 1 < len(ev) else s + du
    m = (t + 0.75 >= s) & (t + 0.75 < e) & (f > 0)
    print(f'{s:7.1f}-{e:7.1f} {np.median(f[m]) if m.any() else 0:5.0f}Hz  {x[:80]}')
