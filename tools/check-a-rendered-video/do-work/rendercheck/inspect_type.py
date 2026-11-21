"""check-a-rendered-video inspect type-sync <video> --spec S --limits L [--overlay O --timeline T]

Per typed line of a rendered overlay, the numbers behind type-sync's verdict: its box, the overlay frames, the frames where it appears and
changes, and the reveal times the check reads (computed by checks/type_sync.py itself). The lines a person reads go to standard error; the last
line on standard output is {"result": {"overlay_fps", "lines": [...]}}. It changes nothing it reads."""
import argparse
import contextlib
import json
import sys

import numpy as np

from rendercheck import config  # noqa: E402
from rendercheck.ctx import Context  # noqa: E402
from rendercheck.checks import type_sync as ts  # noqa: E402


def type_lines(preview, spec, overlay, timeline, LIMITS):
    """Per-line change profile of each typed element in a rendered overlay."""
    ctx = Context(preview, json.load(open(spec)), config.load(str(LIMITS)), overlay=overlay, timeline=timeline)
    c = ctx.cfg['type_sync']
    out = []
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
            out.append({'event': ev.get('id'), 'line': ln, 'box': [float(v) for v in box], 'frames': len(fr),
                        'appear_frames': [int(i) for i in np.where(ch > c['appear_change_frac'] * area)[0][:10]],
                        'live_frames': int((ch > c['min_change_frac'] * area).sum()),
                        'first_changes': [[int(i), round(float(ch[i] / area), 4)] for i in range(len(fr)) if ch[i] > 0][:20],
                        'reveal': [float(x) for x in ts.line_reveal(ctx, box, ln, ts.speed(ev, c))]})
    return {'overlay_fps': ctx.overlay_fps(), 'lines': out}


def main(argv):
    ap = argparse.ArgumentParser(prog='check-a-rendered-video inspect type-sync', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('video')
    ap.add_argument('--spec', required=True)
    ap.add_argument('--limits', required=True, help="the person's limits, or their list:settings row for this tool")
    ap.add_argument('--overlay')
    ap.add_argument('--timeline')
    a = ap.parse_args(argv)
    with contextlib.redirect_stdout(sys.stderr):
        result = type_lines(a.video, a.spec, a.overlay, a.timeline, a.limits)
    print(json.dumps({'result': result}, default=str))
    return 0
