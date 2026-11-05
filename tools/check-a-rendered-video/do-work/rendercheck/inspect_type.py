#!/usr/bin/env python3
"""Per-line change profile of a typed element in a rendered overlay: debug_type.py <preview> <spec> <overlay> <timeline>"""
import json
import os
import sys
import pathlib

import numpy as np

sys.path.insert(0, str(pathlib.Path(os.environ['TRILLION_WORKSHOP']) / 'tools' / 'check-a-rendered-video' / 'do-work'))      # the Workshop's check-a-rendered-video (set TRILLION_WORKSHOP to its checkout)
LIMITS = pathlib.Path(__file__).resolve().parents[2] / 'library' / 'tool-settings' / 'check-a-rendered-video-limits.json'
from rendercheck import config  # noqa: E402
from rendercheck.ctx import Context  # noqa: E402
from rendercheck.checks import type_sync as ts  # noqa: E402

preview, spec, overlay, timeline = sys.argv[1:5]
ctx = Context(preview, json.load(open(spec)), config.load(str(LIMITS)), overlay=overlay, timeline=timeline)
c = ctx.cfg['type_sync']
for ev in ts.type_on_events(ctx):
    lines = ev['text'].split('\n')
    for ln, box in zip(lines, ts.line_boxes(ctx, ev, lines)):
        fr = ts.box_frames(ctx.overlay, box)
        ch = np.zeros(len(fr))
        ch[1:] = (np.abs(fr[1:] - fr[:-1]).max(axis=3) > c['pixel_delta']).sum(axis=(1, 2))
        area = fr.shape[1] * fr.shape[2]
        print(box, repr(ln), 'fps', ctx.overlay_fps(), 'frames', len(fr))
        print(' appear at', np.where(ch > c['appear_change_frac'] * area)[0][:10], 'live frames', int((ch > c['min_change_frac'] * area).sum()))
        print(' first changes', [(i, round(ch[i] / area, 4)) for i in range(len(fr)) if ch[i] > 0][:20])
        print(' reveal', ts.line_reveal(ctx, box, ln, ts.speed(ev, c)))
