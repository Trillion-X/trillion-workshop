"""exits: an element that exits by moving keeps moving until it has fully left the frame; it never
vanishes on screen. In the overlay's alpha each connected shape is followed to the shape it
overlaps most in the next frame; a shape that was moving, then has no successor while its box is clear of the frame edge,
is a vanish, unless it is the last remnant of a stroke erasing in place (a small part of its predecessor's own pixels, erase_area_frac, erase_inside_frac). Elements that stay put and pop out are not moving exits and are not judged here."""
import cv2
import numpy as np

from ..report import Finding
from .in_frame import _box

NAME = 'exits'

OVERLAY_ONLY = True      # on a plain video (no overlay, no spec events) there is nothing of this kind to measure: an empty set, reported as a pass


def needs(ctx):
    return None if ctx.overlay else 'no overlay.mov'


def shapes(mask, min_area, bleed_frac):
    n, lab, stats, cents = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    return [{'box': (int(x), int(y), int(x + w), int(y + h)), 'c': cents[i], 'area': int(area), 'mask': lab == i, 'speed_in': 0.0, 'next': None}
            for i, (x, y, w, h, area) in ((i, stats[i]) for i in range(1, n)) if min_area <= area < bleed_frac * mask.size]


def windows(ctx):
    """Frame-px boxes of the windows the spec declares children inside (`masked_within: <parent id>`). The parent's box is its declared
    `window` [x0, y0, x1, y1] or the spec box model of its type; a parent whose box cannot be found exempts nothing."""
    c = ctx.cfg['in_frame']
    events = ctx.spec.get('events', [])
    parents = {ev['masked_within'] for ev in events if ev.get('masked_within')}
    out = []
    for ev in events:
        if ev.get('id') not in parents:
            continue
        if isinstance(ev.get('window'), list) and len(ev['window']) == 4:
            out.append(tuple(ev['window']))
        elif ev['type'] in c['spec_boxes'] and 'pos' in ev:
            box = _box(ev, c['spec_boxes'][ev['type']], c['spec_defaults'])
            if box:
                out.append(box)
    return out


def run(ctx):
    c = ctx.cfg['exits']
    a = ctx.overlay_alpha()
    n, h, w = a.shape
    ofps = ctx.overlay_fps()
    t0 = ctx.overlay_t0 or 0.0
    px = ctx.cfg['frame']['width'] / w
    masks = windows(ctx)
    frames = [shapes(a[i] > c['alpha_threshold'], c['min_area_px'], c['bleed_area_frac']) for i in range(n)]
    for i in range(n - 1):
        for s in frames[i]:
            overlaps = [int((s['mask'] & nxt['mask']).sum()) for nxt in frames[i + 1]]
            if overlaps and max(overlaps) >= c['continue_overlap_frac'] * s['area']:
                k = int(np.argmax(overlaps))
                s['next'] = k
                frames[i + 1][k]['speed_in'] = float(np.hypot(*(frames[i + 1][k]['c'] - s['c'])))
                frames[i + 1][k]['prev'] = s
    out, ends = [], 0
    for i in range(1, n - 1):
        for s in frames[i]:
            if s['next'] is not None:
                continue
            cx, cy = s['c'][0] * px, s['c'][1] * px
            if any(b[0] <= cx <= b[2] and b[1] <= cy <= b[3] for b in masks):
                continue        # a child inside a declared mask or window is not an exit
            prev = s.get('prev')
            if prev is not None and s['area'] <= c['erase_area_frac'] * prev['area'] and int((s['mask'] & prev['mask']).sum()) >= c['erase_inside_frac'] * s['area']:
                continue        # a stroke that shrinks in place (written or un-written) is not a mover: its centre shifts only because pixels vanish
            ends += 1
            x0, y0, x1, y1 = s['box']
            tol = c['edge_tolerance_px']
            on_edge = x0 <= tol or y0 <= tol or x1 >= w - tol or y1 >= h - tol
            if s['speed_in'] >= c['moving_px_per_frame'] and not on_edge:
                out.append(Finding(NAME, 'FAIL', f'a moving element ({s["speed_in"] * px:.0f}px/frame) vanishes with its box {int(x0 * px)},{int(y0 * px)}-{int(x1 * px)},{int(y1 * px)} still inside the frame; '
                                   'keep it moving until it has left', t0 + i / ofps, None, {'speed': s['speed_in']}))
    return out or [Finding(NAME, 'INFO', f'{ends} shape ends followed; none was moving and vanished inside the frame')]
