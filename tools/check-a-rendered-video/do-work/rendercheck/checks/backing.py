"""backing: every card, strip or label backing differs clearly in lightness from what is behind it, against a page or surface.
Each backing element's box comes from the overlay's timeline.json (id, box in frame px). On the rendered video, a settle time after the
element lands, the backing lightness is the median of a ring just inside the box edge (the card's border, clear of its text)
and the surround is the median of a ring outside it (the surface), leaving out other elements' boxes. A backing passes when it is clearly
LIGHTER than the surface or clearly much DARKER; a slightly different tone either way is the "same tone"
that is rejected, because an element of nearly the same tone reads as the surface."""
import numpy as np

from .. import media
from ..report import Finding

EMPTY_SET = 'no card, strip or label element'      # a spec fact: reported as a pass, not a skip
NAME = 'backing'


def backing_events(ctx):
    types = set(ctx.cfg['backing']['types'])
    return [ev for ev in ctx.spec.get('events', []) if ev.get('type') in types and ev.get('id')]


def needs(ctx):
    if not backing_events(ctx):
        return 'no card, strip or label element in the spec'
    if not ctx.timeline:
        return 'no timeline.json (element boxes unknown)'
    if ctx.overlay_t0 is None:
        return 'spec has no edit.overlay.at'
    return None


def first_boxes(ctx):
    seen = {}
    for b in ctx.timeline.get('boxes', []):
        seen.setdefault(b['id'], b)
    return seen


def lightness(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def measure(frame, box, others, c):
    """(backing lightness, surround lightness, surround pixel count) of one element on one frame (rgb floats)."""
    h, w = frame.shape[:2]
    x0, y0, x1, y1 = [int(v) for v in box]
    lum = lightness(frame)
    back = np.zeros((h, w), bool)
    back[y0 + c['inner_from_px']:y1 - c['inner_from_px'], x0 + c['inner_from_px']:x1 - c['inner_from_px']] = True
    back[y0 + c['inner_to_px']:y1 - c['inner_to_px'], x0 + c['inner_to_px']:x1 - c['inner_to_px']] = False
    sur = np.zeros((h, w), bool)
    far, near = c['surround_to_px'], c['surround_from_px']
    sur[max(y0 - far, 0):y1 + far, max(x0 - far, 0):x1 + far] = True
    sur[max(y0 - near, 0):y1 + near, max(x0 - near, 0):x1 + near] = False
    for ox0, oy0, ox1, oy1 in others:
        sur[max(oy0 - c['other_margin_px'], 0):oy1 + c['other_margin_px'], max(ox0 - c['other_margin_px'], 0):ox1 + c['other_margin_px']] = False
    if not back.any():
        return None
    return float(np.median(lum[back])), (float(np.median(lum[sur])) if sur.any() else None), int(sur.sum())


def run(ctx):
    c = ctx.cfg['backing']
    boxes = first_boxes(ctx)
    fw, fh = ctx.cfg['frame']['width'], ctx.cfg['frame']['height']
    duration = ctx.timeline.get('duration_s') or ctx.info['duration']
    out = []
    for ev in backing_events(ctx):
        b = boxes.get(ev['id'])
        if not b:
            out.append(Finding(NAME, 'WARN', f'{ev["type"]} "{ev["id"]}": no box in timeline.json, so its backing is not measured', data={'not_measured': True}))
            continue
        t_overlay = min(b['t0'] + c['settle_s'], max(duration - c['end_margin_s'], b['t0']))
        t_prev = ctx.overlay_t0 + t_overlay
        if t_prev < 0 or t_prev > ctx.info['duration']:
            out.append(Finding(NAME, 'WARN', f'{ev["type"]} "{ev["id"]}": its settled moment ({t_prev:.1f}s) is outside the preview, so its backing is not measured', data={'not_measured': True}))
            continue
        frame = media.frames(ctx.preview, fw, fh, 'rgb24', ss=t_prev, t=0.05)[0].astype(np.float32)
        others = [[int(v) for v in o['box']] for k, o in boxes.items() if k != ev['id']]
        m = measure(frame, b['box'], others, c)
        if m is None or m[1] is None or m[2] < c['min_surround_px']:
            out.append(Finding(NAME, 'WARN', f'{ev["type"]} "{ev["id"]}": too little page around it to compare ({0 if m is None else m[2]} px), so its backing is not measured', data={'not_measured': True}))
            continue
        back, sur, _ = m
        diff = back - sur
        ok = diff >= c['lighter_min_diff'] or -diff >= c['darker_min_diff']
        msg = (f'{ev["type"]} "{ev["id"]}": backing lightness {back:.0f} against the page {sur:.0f} ({diff:+.0f}); '
               + ('stands out' if ok else f'same tone as the page: it must be at least {c["lighter_min_diff"]:g} lighter or {c["darker_min_diff"]:g} darker'))
        out.append(Finding(NAME, 'INFO' if ok else 'FAIL', msg, t_prev, data={'diff': diff, 'backing': back, 'surround': sur}))
    return out
