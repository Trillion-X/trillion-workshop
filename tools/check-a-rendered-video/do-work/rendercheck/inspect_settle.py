#!/usr/bin/env python3
"""Mass and centroid of the overlay alpha per frame, with and without the occlusion fill: debug_settle.py <preview> <spec> <overlay> <timeline>"""
import json
import os
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(os.environ['TRILLION_WORKSHOP']) / 'tools' / 'check-a-rendered-video' / 'do-work'))      # the Workshop's check-a-rendered-video (set TRILLION_WORKSHOP to its checkout)
LIMITS = pathlib.Path(__file__).resolve().parents[2] / 'library' / 'tool-settings' / 'check-a-rendered-video-limits.json'
from rendercheck import config  # noqa: E402
from rendercheck.ctx import Context  # noqa: E402
from rendercheck.checks import settle  # noqa: E402

p, s, o, t = sys.argv[1:5]
ctx = Context(p, json.load(open(s)), config.load(str(LIMITS)), overlay=o, timeline=t)
a0 = ctx.overlay_alpha().astype(np.float32)
ofps = ctx.overlay_fps()
a1, missing = settle.unmask(ctx, a0.copy(), ofps)
print('missing', missing, 'occlusions', [(b, x, y) for b, x, y, _ in settle.occlusions(ctx)])
ys, xs = np.mgrid[0:a0.shape[1], 0:a0.shape[2]]
for name, a in (('raw', a0), ('unmasked', a1)):
    mass = a.sum(axis=(1, 2))
    cx = (a * xs).sum(axis=(1, 2)) / (mass + 1e-9) * 4
    print(name, 'mass', [int(m) for m in mass[2:90:8]], 'cx', [round(float(c), 1) for c in cx[2:90:8]])
