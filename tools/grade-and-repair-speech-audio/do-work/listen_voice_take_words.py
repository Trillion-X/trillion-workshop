#!/usr/bin/env python3
"""Listen word by word with earshot: realness (real voice vs synthesized) and a glitch match per word, ranked
against the take's own median so one odd word stands out. Usage: voice_listen.py <wav> <words.json> <offset_s> <out.json>"""
import json, sys
import numpy as np
from earshot import api

wav, wj, off, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
w = json.load(open(wj)); w = w.get('words', w) if isinstance(w, dict) else w
GLITCH, CLEAN = 'a glitch, click, warble or robotic artifact in a voice', 'a calm male voice speaking clearly'
rows = []
for x in w:
    a, b = max(0.0, x['start'] + off - 0.06), x['end'] + off + 0.06
    r = api.realness(wav, start=a, end=b)
    m = api.match(wav, [GLITCH, CLEAN], start=a, end=b)
    z = {q['query']: q['z'] for q in m['results']}
    rows.append({'word': x['text'], 'start': round(a, 3), 'end': round(b, 3), 'p_real': r.get('p_real'), 'z_glitch': z[GLITCH], 'z_clean': z[CLEAN]})
pr = np.array([r['p_real'] for r in rows], float)
zg = np.array([r['z_glitch'] for r in rows], float)
for r in rows:
    r['p_real_dev'] = round((r['p_real'] - np.median(pr)) / (pr.std() + 1e-6), 2)
    r['z_glitch_dev'] = round((r['z_glitch'] - np.median(zg)) / (zg.std() + 1e-6), 2)
json.dump(rows, open(out, 'w'), indent=1)
for r in sorted(rows, key=lambda r: r['p_real_dev'])[:5]:
    print('low p_real ', r['word'], r['start'], r['p_real'], r['p_real_dev'])
for r in sorted(rows, key=lambda r: -r['z_glitch_dev'])[:5]:
    print('high glitch', r['word'], r['start'], r['z_glitch'], r['z_glitch_dev'])
