"""placement: a graphic does not sit where the person on screen is showing something.
The action zone is measured from the footage itself: the mean absolute grey change between consecutive video frames at each cell of a heat_width x heat_height
grid, only over the frames where the overlay does not cover that cell (so the graphic's own motion is never counted). A graphic box of the timeline (not a full
frame cover, under max_box_frac of the frame) fails when the footage under it moves at least action_heat on average (hands and what they hold) and at least
min_uncovered_frac of the video frames could be observed there."""
import cv2
import numpy as np

from .. import media
from ..report import Finding

NAME = 'placement'

OVERLAY_ONLY = True
EMPTY_SET = 'not applicable: every graphic'


def covers_only(ctx, c):
    """True when the spec has graphics and every one of them is a full-frame cover (covers_a_roll): the frame is covered, so no graphic sits over the footage."""
    graphics = [ev for ev in ctx.spec.get('events', []) if ev.get('type') not in c['non_graphic_types']]
    return bool(graphics) and all(ev.get(c['cover_key']) for ev in graphics)


def needs(ctx):
    c = ctx.cfg['placement']
    if ctx.overlay and ctx.timeline and ctx.timeline.get('boxes'):
        return None
    if ctx.overlay and covers_only(ctx, c):
        return 'not applicable: every graphic in this video is a full-frame cover (covers_a_roll), so none sits over the footage to be judged'
    return 'no overlay.mov or no element boxes in its timeline'


def composite_heat(ctx, c):
    """(heat grid, observed fraction grid) from the delivered video, only where the overlay does not cover."""
    w, h = c['heat_width'], c['heat_height']
    g = media.frames(ctx.preview, w, h, 'gray').astype(np.float32)
    fps = ctx.info['fps']
    a = ctx.overlay_alpha()
    ofps = ctx.overlay_fps()
    t0 = ctx.overlay_t0 or 0.0
    d = np.abs(np.diff(g, axis=0))
    heat, seen = np.zeros((h, w)), np.zeros((h, w))
    for k in range(len(d)):
        j = int((k / fps - t0) * ofps)
        free = ~(cv2.resize(a[j], (w, h)) > c['covered_alpha']) if 0 <= j < len(a) else np.ones((h, w), bool)
        heat[free] += d[k][free]
        seen[free] += 1
    return heat / np.maximum(seen, 1), seen / max(len(d), 1)


def run(ctx):
    c = ctx.cfg['placement']
    w, h = c['heat_width'], c['heat_height']
    fw, fh = ctx.cfg['frame']['width'], ctx.cfg['frame']['height']
    t0 = ctx.overlay_t0 or 0.0
    heat, frac = composite_heat(ctx, c)
    cover_ids = {str(ev.get('id')) for ev in ctx.spec.get('events', []) if ev.get(c['cover_key'])}
    out, judged, covers, unseen, peak = [], 0, 0, [], 0.0
    for b in ctx.timeline['boxes']:
        x0, y0, x1, y1 = b['box']
        if (x1 - x0) * (y1 - y0) > c['max_box_frac'] * fw * fh or b['id'].split('-')[0] in cover_ids:
            covers += 1
            continue
        sx, sy = w / fw, h / fh
        ix0, iy0, ix1, iy1 = max(int(x0 * sx), 0), max(int(y0 * sy), 0), min(int(np.ceil(x1 * sx)), w), min(int(np.ceil(y1 * sy)), h)
        if ix1 <= ix0 or iy1 <= iy0 or frac[iy0:iy1, ix0:ix1].mean() < c['min_uncovered_frac']:
            unseen.append(b['id'])
            continue
        judged += 1
        m = float(heat[iy0:iy1, ix0:ix1].mean())
        peak = max(peak, m)
        if m >= c['action_heat']:
            out.append(Finding(NAME, 'FAIL', f'graphic "{b["id"]}" sits over footage that moves {m:.1f} (limit {c["action_heat"]}): that is where the person is showing or doing something; move it to the side of the frame where nothing moves',
                               t0 + b['t0'], data={'id': b['id'], 'heat': m}))
    if out:
        return out
    if unseen:
        return [Finding(NAME, 'WARN', f'{judged} graphic boxes measured; {len(unseen)} ({", ".join(sorted(set(unseen)))}) could not be observed (the overlay covers that part of the frame for nearly all of the video), so their placement is not measured',
                        data={'not_measured': True})]
    if not judged:
        return [Finding(NAME, 'INFO', f'{EMPTY_SET} ({covers} box(es)) is a full-frame cover, so none sits over the footage to be judged', data={'empty_set': True})]
    return [Finding(NAME, 'INFO', f'{judged} graphic boxes measured; none sits over moving hands or held objects (highest mean change under a box {peak:.2f}, limit {c["action_heat"]})', data={'peak_heat': peak})]
