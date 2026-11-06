"""Caption lines with the median stored window pitch (from an .emb.npz), for hand-labelling who speaks.
usage: python3 -I show/show_line_pitch.py <id> <start> <end> <data_folder> <youtube_folder>
(the windows are <data_folder>/voice/<id>.emb.npz of do-work/find_voice.py; the captions <youtube_folder>/{captions,videos}/<id>.en*.json3)"""
import os, sys, glob, numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
from shared import events
VOICE, YT = os.path.join(sys.argv[4], 'voice'), sys.argv[5]
vid, a, b = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
d = np.load(os.path.join(VOICE, vid + '.emb.npz')); t, f = d['t'], d['f0']
fs = [x for dd in ('captions', 'videos') for x in sorted(glob.glob(os.path.join(YT, dd, vid + '.en*.json3')))]
ev = events(fs[0])
for i, (s, du, x) in enumerate(ev):
    if not a <= s <= b: continue
    e = ev[i + 1][0] if i + 1 < len(ev) else s + du
    m = (t + 0.75 >= s) & (t + 0.75 < e) & (f > 0)
    print(f'{s:7.1f}-{e:7.1f} {np.median(f[m]) if m.any() else 0:5.0f}Hz  {x[:80]}')
