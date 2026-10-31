"""broll: cutaway footage stays on screen long enough to register and is colour graded to match the footage around it.
A full-frame cutaway is a stretch where the overlay covers the frame (full_opaque_frac) that holds an event of a type in config broll.cutaway_types.
  - long enough: it is on screen more than min_s unless the spec declares the event a flash cut (`flash_cut: true` on the event, or `flash_cut_purpose` naming it);
  - graded: the mean Lab colour of the cutaway frames is under max_delta_e from the mean Lab colour of the A-roll frames just before and after it (adjacent_s each side).
A video with no such cutaway is an empty set."""
import cv2
import numpy as np

from .. import media
from ..report import Finding
from .dwell import stretches

NAME = 'broll'
EMPTY_SET = 'no full-frame cutaway in the spec'


def cutaways(ctx):
    c = ctx.cfg['broll']
    return [ev for ev in ctx.spec.get('events', []) if ev.get('type') in c['cutaway_types']]


def needs(ctx):
    if not cutaways(ctx):
        return EMPTY_SET
    return None if ctx.overlay else 'no overlay.mov'


def run(ctx):
    c = ctx.cfg['broll']
    a = ctx.overlay_alpha()
    ofps = ctx.overlay_fps()
    t0 = ctx.overlay_t0 or 0.0
    full = (a > c['alpha']).mean(axis=(1, 2)) > ctx.cfg['face']['full_opaque_frac']
    fps = ctx.info['fps']
    frames = media.frames(ctx.preview, c['width'], c['height'], 'rgb24').astype(np.float32) / 255
    lab = np.array([cv2.cvtColor(f, cv2.COLOR_RGB2LAB).reshape(-1, 3).mean(axis=0) for f in frames])
    starts = [(ctx.element_start(ev), ev) for ev in cutaways(ctx)]
    out, judged = [], 0
    for i, j in stretches(full, ofps, c['gap_s']):
        s, e = t0 + i / ofps, t0 + j / ofps
        owner = next((ev for t, ev in starts if t is not None and i / ofps - c['lead_s'] <= t <= j / ofps), None)
        if owner is None:
            continue
        judged += 1
        flash = owner.get('flash_cut') or len(str((ctx.spec or {}).get('flash_cut_purpose', '')).strip()) >= c['min_purpose_chars']
        if e - s <= c['min_s'] and not flash:
            out.append(Finding(NAME, 'FAIL', f'{owner["type"]} "{owner.get("id")}" is on screen {e - s:.2f}s (needs more than {c["min_s"]} s to register; declare `flash_cut` only if it is meant as one): provisional, calibrated on one verdict',
                               s, e, {'dur_s': e - s}))
        k0, k1 = int(s * fps), int(e * fps)
        mid = lab[k0 + 2:max(k1 - 2, k0 + 3)].mean(axis=0)
        adj = int(c['adjacent_s'] * fps)
        around = [seg.mean(axis=0) for seg in (lab[max(k0 - adj, 0):max(k0 - 1, 1)], lab[min(k1 + 2, len(lab) - 1):min(k1 + adj, len(lab))]) if len(seg)]
        if around:
            de = float(np.linalg.norm(mid - np.mean(around, axis=0)))
            if de >= c['max_delta_e']:
                out.append(Finding(NAME, 'FAIL', f'{owner["type"]} "{owner.get("id")}" is {de:.1f} in Lab colour from the A-roll around it (limit under {c["max_delta_e"]}): grade the cutaway to match the footage around it; provisional, calibrated on one verdict',
                                   s, e, {'delta_e': de}))
    return out or [Finding(NAME, 'INFO', f'{judged} full-frame cutaways judged; each is on screen more than {c["min_s"]} s and within {c["max_delta_e"]} Lab of the A-roll')]
