"""check-a-rendered-video inspect settle <video> --spec S --limits L [--overlay O --timeline T] [--from s --to s] [--sample-start N --sample-step N]

The numbers behind settle's verdict on one video, for a person or their AI tuning a limit: the overlay's alpha mass and centroid per frame, with
and without the occlusion fill, and each declared occlusion; the landing windows settle judges and the beats the rest split cuts each into (on
the silhouette settle itself reads); and, given --from/--to (overlay seconds), the per-frame motion by half second. The lines a person reads go to
standard error; the last line on standard output is {"result": {...}}. It changes nothing it reads."""
import argparse
import contextlib
import json
import sys

import numpy as np

from rendercheck import config  # noqa: E402
from rendercheck.ctx import Context  # noqa: E402
from rendercheck.checks import settle  # noqa: E402


def _sample(v, start, step):
    return [round(float(x), 1) for x in v[start::step]]


def masses(p, s, o, t, LIMITS, start, step):
    """Mass and centroid of the overlay alpha per frame, with and without the occlusion fill."""
    ctx = Context(p, json.load(open(s)), config.load(str(LIMITS)), overlay=o, timeline=t)
    a0 = ctx.overlay_alpha().astype(np.float32)
    ofps = ctx.overlay_fps()
    a1, missing = settle.unmask(ctx, a0.copy(), ofps)
    print('missing', missing, 'occlusions', [(b, x, y) for b, x, y, _ in settle.occlusions(ctx)])
    out = {'overlay_fps': ofps, 'missing_mattes': missing, 'traces': {}, 'sample_frames': {'start': start, 'step': step},
           'occlusions': [{'box': b, 'from_s': x, 'to_s': y, 'matte': m} for b, x, y, m in settle.occlusions(ctx)]}
    ys, xs = np.mgrid[0:a0.shape[1], 0:a0.shape[2]]
    sc = ctx.cfg['frame']['width'] / a0.shape[2]
    for name, a in (('raw', a0), ('unmasked', a1)):
        mass = a.sum(axis=(1, 2))
        cx = (a * xs).sum(axis=(1, 2)) / (mass + 1e-9) * sc
        print(name, 'mass', [int(m) for m in mass[start::step]], 'cx', [round(float(c), 1) for c in cx[start::step]])
        out['traces'][name] = {'mass': _sample(mass, start, step), 'cx': _sample(cx, start, step)}
    return out


def windows(p, s, o, t, LIMITS, motion_from=None, motion_to=None):
    """Landing windows settle judges, before and after the rest split; and the per-frame motion over a stretch."""
    ctx = Context(p, json.load(open(s)), config.load(str(LIMITS)), overlay=o, timeline=t)
    c = ctx.cfg['settle']
    a, _ = settle.unmask(ctx, ctx.overlay_alpha().astype(np.float32), ctx.overlay_fps())
    a = settle.silhouette(a, c['geometry_window_px'])      # what settle's run reads (checks/settle.py), so these are the windows it judges
    ofps = ctx.overlay_fps()
    ys, xs = np.mgrid[0:a.shape[1], 0:a.shape[2]]
    mass = a.sum(axis=(1, 2))
    sc = ctx.cfg['frame']['width'] / a.shape[2]
    n = int(c['smooth_s'] * ofps)
    cx = settle.smooth((a * xs).sum(axis=(1, 2)) / (mass + 1e-9) * sc, n)
    cy = settle.smooth((a * ys[None]).sum(axis=(1, 2)) / (mass + 1e-9) * sc, n)
    covered = (a > ctx.cfg['in_frame']['alpha_threshold']).mean(axis=(1, 2)) > ctx.cfg['dwell']['min_cover_frac']
    out = {'windows': []}
    for f, e in settle.landing_windows(ctx, covered, ofps):
        parts = settle.split_at_rests(cx, cy, mass, f, e, ofps, c)
        print(f'window {f / ofps:.1f}-{e / ofps:.1f}s ->', [(round(x / ofps, 1), round(y / ofps, 1)) for x, y, _ in parts])
        out['windows'].append({'window_s': [round(f / ofps, 2), round(e / ofps, 2)], 'beats_s': [[round(x / ofps, 2), round(y / ofps, 2)] for x, y, _ in parts]})
    if motion_from is not None and motion_to is not None:
        f0, e0 = int(motion_from * ofps), int(motion_to * ofps)
        step = np.hypot(np.diff(cx[f0:e0]), np.diff(cy[f0:e0])) + c['mass_px_per_frac'] * np.abs(np.diff(mass[f0:e0])) / (mass[f0:e0 - 1] + 1e-9)
        half = max(int(ofps / 2), 1)
        print('per-frame motion (px) by 0.5 s:', [round(float(step[i:i + half].max()), 2) for i in range(0, len(step), half)])
        out['motion_px_by_half_second'] = [round(float(step[i:i + half].max()), 2) for i in range(0, len(step), half)]
    return out


def main(argv):
    ap = argparse.ArgumentParser(prog='check-a-rendered-video inspect settle', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('video')
    ap.add_argument('--spec', required=True)
    ap.add_argument('--limits', required=True, help="the person's limits, or their list:settings row for this tool")
    ap.add_argument('--overlay')
    ap.add_argument('--timeline')
    ap.add_argument('--from', dest='from_s', type=float, help='overlay second the per-frame motion starts at')
    ap.add_argument('--to', dest='to_s', type=float, help='overlay second it ends at')
    ap.add_argument('--sample-start', dest='sample_start', type=int, default=2, help='first overlay frame of the sampled traces')
    ap.add_argument('--sample-step', dest='sample_step', type=int, default=8, help='frames between samples')
    a = ap.parse_args(argv)
    with contextlib.redirect_stdout(sys.stderr):
        out = masses(a.video, a.spec, a.overlay, a.timeline, a.limits, a.sample_start, a.sample_step)
        out.update(windows(a.video, a.spec, a.overlay, a.timeline, a.limits, a.from_s, a.to_s))
    print(json.dumps({'result': out}, default=str))
    return 0
