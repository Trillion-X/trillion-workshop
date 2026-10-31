"""tempo: a graphic finishes its point and leaves or changes; it never sits idle for long (for example an animation sitting on screen for 16 seconds before anything else happens).
Measured on the rendered overlay: a frame is idle when the overlay is on screen and nothing on it changed since the frame before: not its alpha mass, not its
alpha-weighted centroid (idle_motion; the slow sway of a drifting element is under it) and not its picture (mean grey change under idle_pixel_change, so a card landing
on an opaque surface counts as a change). An idle run longer than max_idle_s fails, whatever the graphic is: the longest
the viewer should look at a graphic that does nothing. A spec may declare `long_hold_purpose` (>= 12 characters). A video with no overlay is an empty set."""
import numpy as np

from .. import media
from ..report import Finding
from .dwell import stretches
from .settle import smooth

NAME = 'tempo'

OVERLAY_ONLY = True


def needs(ctx):
    return None if ctx.overlay else 'no overlay.mov'


def run(ctx):
    c = ctx.cfg['tempo']
    a = ctx.overlay_alpha().astype(np.float32)
    ofps = ctx.overlay_fps()
    scale = ctx.cfg['frame']['width'] / a.shape[2]
    t0 = ctx.overlay_t0 or 0.0
    mass = a.sum(axis=(1, 2))
    ys, xs = np.mgrid[0:a.shape[1], 0:a.shape[2]]
    cx = smooth((a * xs).sum(axis=(1, 2)) / (mass + 1e-9) * scale, int(c['smooth_s'] * ofps))
    cy = smooth((a * ys[None]).sum(axis=(1, 2)) / (mass + 1e-9) * scale, int(c['smooth_s'] * ofps))
    motion = np.zeros(len(mass))
    motion[1:] = np.hypot(np.diff(cx), np.diff(cy)) + c['mass_px_per_frac'] * np.abs(np.diff(mass)) / (mass[1:] + 1e-9)
    g = media.frames(ctx.overlay, a.shape[2], a.shape[1], 'gray').astype(np.float32)
    pix = np.zeros(len(mass))
    pix[1:] = np.abs(np.diff(g, axis=0)).mean(axis=(1, 2))
    covered = (a > ctx.cfg['in_frame']['alpha_threshold']).mean(axis=(1, 2)) > ctx.cfg['dwell']['min_cover_frac']
    idle = covered & (smooth(motion, int(c['smooth_s'] * ofps)) < c['idle_motion']) & (smooth(pix, int(c['smooth_s'] * ofps)) < c['idle_pixel_change'])
    why = str((ctx.spec or {}).get(c['purpose_key'], '')).strip()
    out, longest = [], 0.0
    for i, j in stretches(idle, ofps, c['gap_s']):
        dur = (j - i) / ofps
        longest = max(longest, dur)
        if dur > c['max_idle_s']:
            level = 'INFO' if len(why) >= c['min_purpose_chars'] else 'FAIL'
            out.append(Finding(NAME, level, f'a graphic sits idle for {dur:.1f}s (from {t0 + i / ofps:.1f}s): nothing on it moves or changes (limit {c["max_idle_s"]} s); finish its point sooner, change it or let it leave'
                               + (f'; declared: {why}' if level == 'INFO' else ''), t0 + i / ofps, t0 + j / ofps, {'idle_s': dur}))
    return out or [Finding(NAME, 'INFO', f'longest idle graphic {longest:.1f}s (limit {c["max_idle_s"]} s)')]
