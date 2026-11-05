"""Shared drawing helpers for the chapter-4 event files (tools/events/*.py). Imported after r3 is loaded, so r3, r2 and rc
are the live renderer modules (same look, same sprites, same sound table)."""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw
from overlay import kit, look, stage

face, col, ease_out, ease_in = kit.face, kit.col, kit.ease_out, kit.ease_in
SAFE = kit.SAFE
FPS = stage.FPS


def blur_moves(dyn):
    """Wrap a smooth (frame-exact, not stop-motion) sprite's dynamic(tt) -> (img, x, y) so each frame carries the motion blur
    of its own travel over the last 1.5 frames (the person's rules synthetic-4015c76f9424; the shared smear of events/_ch2_motion.py).
    A still frame, or a paper piece on twos, is left sharp: only moves of 3 px or more smear."""
    from overlay.helpers import motion_smear as M
    step = 1.5 * M.FRAME_S

    def wrapped(tt):
        img, x, y = dyn(tt)
        if img is None:
            return img, x, y
        _, x0, y0 = dyn(tt - step)
        if x0 is None:
            return img, x, y
        return M.smear(img, x, y, x - x0, y - y0)
    return wrapped


def slide_side(e, x_end, w):
    """The side edge a card enters from and leaves by: spec `slide` ('left' or 'right'), else the edge nearer the card, so a
    card never sweeps across his face on its way in or out (the person's rules synthetic-1bb5ee8838dd, synthetic-73042df8cd3b)."""
    return e.get('slide') or ('left' if x_end + w / 2 < stage.W / 2 else 'right')


def slide_x(tt, t_in, t_out, x_end, w, side, enter=True):
    """x of a card of width w resting at x_end that slides in from (when enter) and out to its side edge; None once it has
    left the frame."""
    sl = look.LOOK['slide']
    sign, dist = (-1, x_end + w + 60) if side == 'left' else (1, stage.W - x_end + 60)
    x = x_end
    if enter and tt < t_in + sl['in_s']:
        x += sign * (1 - ease_out((tt - t_in) / sl['in_s'])) * dist
    if tt >= t_out:
        v = ease_in((tt - t_out) / sl['out_s'])
        if v >= 1:
            return None
        x += sign * v * (dist + 20)
    return x


def ease_in_out(x, p=2.0):
    x = min(max(x, 0.0), 1.0)
    return 0.5 * (2 * x) ** p if x < 0.5 else 1 - 0.5 * (2 * (1 - x)) ** p


def paper(w, h, kind, seed, edge_amp=3, step=8):
    """A torn piece of paper: kind white | kraft | newsprint | cream | aged | thermal | index."""
    fills = {'white': stage.rgb('paper_white'), 'kraft': stage.rgb('kraft'), 'newsprint': (228, 224, 214), 'cream': (243, 235, 214),
             'aged': (236, 226, 200), 'thermal': (246, 245, 241), 'index': (252, 251, 246)}
    tex = {'kraft': 'kraft', 'newsprint': 'newsprint'}.get(kind, 'sheet')
    im = Image.new('RGBA', (w, h), fills[kind] + (255,))
    im = stage.apply_texture(im, tex, seed, 0.35 if kind in ('thermal', 'index', 'white') else 0.5)
    m = Image.new('L', (w, h), 0)
    ImageDraw.Draw(m).polygon(stage.torn_polygon(w, h, edge_amp, seed, step=step), fill=255)
    im.putalpha(m)
    return im


def shadow(im, sh=None):
    return stage.shadowed(im, sh or {'dx': 2, 'dy': 7, 'blur': 12, 'opacity': 0.38})


def polyline_length(pts):
    return [0.0] + list(np.cumsum([math.dist(a, b) for a, b in zip(pts, pts[1:])]))


def polyline_prefix(pts, cum, d):
    """Points of the polyline up to arc length d."""
    if d <= 0:
        return pts[:1]
    out = [pts[0]]
    for i in range(1, len(pts)):
        if cum[i] <= d:
            out.append(pts[i])
        else:
            u = (d - cum[i - 1]) / max(cum[i] - cum[i - 1], 1e-6)
            out.append((pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u))
            break
    return out


def catmull(points, n=24):
    """Smooth curve through points (Catmull-Rom), as a dense polyline."""
    p = [points[0]] + list(points) + [points[-1]]
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for k in range(n):
            t = k / n
            t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2
                                    + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in (0, 1)))
    out.append(points[-1])
    return out


def marker_line(d, pts, colour, width, seed=0):
    """A marker line: slightly uneven width along its length, round joints."""
    rng = np.random.default_rng(seed)
    for a, b in zip(pts, pts[1:]):
        d.line([a, b], fill=colour, width=max(1, int(width * rng.uniform(0.9, 1.08))))
    for p in pts[::6]:
        r = width / 2
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=colour)


def highlighter_band(w, h, seed, colour=None, alpha=0.42):
    """A highlighter band: flat colour with soft ragged ends and a little streaking (Highlighter sweep #089, physical
    marker look, no glow). Drawn under ink with multiply."""
    rng = np.random.default_rng(seed)
    colour = colour or stage.rgb(look.section('marker_and_slide')['highlight'])
    a = np.ones((h, w), np.float32)
    a *= (0.88 + 0.12 * rng.uniform(0, 1, (h, 1)))
    ends = np.clip(np.minimum(np.arange(w), w - 1 - np.arange(w)) / max(h * 0.35, 1), 0, 1)
    a *= ends[None, :] ** 0.5
    edge = np.clip(np.minimum(np.arange(h), h - 1 - np.arange(h)) / 3.0, 0, 1)
    a *= edge[:, None]
    im = np.zeros((h, w, 4), np.uint8)
    im[..., :3] = colour
    im[..., 3] = (a * alpha * 255).astype(np.uint8)
    return Image.fromarray(im, 'RGBA')


def multiply(base, over, xy):
    """Multiply-blend `over` (RGBA) onto `base` (RGBA) at xy, keeping base alpha (a highlighter under printed ink)."""
    x, y = int(xy[0]), int(xy[1])
    b = np.asarray(base).astype(np.float32).copy()
    o = np.asarray(over).astype(np.float32)
    h, w = o.shape[:2]
    x0, y0, x1, y1 = max(x, 0), max(y, 0), min(x + w, b.shape[1]), min(y + h, b.shape[0])
    if x1 <= x0 or y1 <= y0:
        return base
    oo = o[y0 - y:y1 - y, x0 - x:x1 - x]
    a = oo[..., 3:4] / 255.0
    bb = b[y0:y1, x0:x1, :3]
    b[y0:y1, x0:x1, :3] = bb * (1 - a) + bb * (oo[..., :3] / 255.0) * a
    return Image.fromarray(b.astype(np.uint8), 'RGBA')


HIGHLIGHTER = {'green': (126, 217, 87), 'yellow': (255, 226, 64), 'red': (255, 92, 92), 'blue': (110, 190, 255)}  # by meaning


def marker_highlight(w, h, seed, colour='yellow'):
    """A real highlighter stroke for multiply under printed ink (the person's rules synthetic-43b5689d4046): the chisel tip leaves an
    uneven top and bottom edge that wanders a few px along the stroke, ink pools darker where the stroke starts and lifts, a
    second pass overlaps the last part a little darker, and fibre streaks run along the stroke. Colour is chosen by meaning
    (green good, yellow neutral, red bad); `colour` is a name in HIGHLIGHTER or an RGB tuple."""
    rng = np.random.default_rng(seed)
    rgb = HIGHLIGHTER.get(colour, colour) if isinstance(colour, str) else colour
    pad = 6
    H = h + 2 * pad
    xs = np.arange(w)
    wob = lambda amp: np.interp(xs, np.linspace(0, w, 7), rng.uniform(-amp, amp, 7))
    top, bot = pad + wob(3.0) + rng.uniform(-1, 1), pad + h + wob(3.0) + rng.uniform(-1, 1)
    yy = np.arange(H)[:, None]
    a = np.clip(yy - top[None, :] + 0.8, 0, 1) * np.clip(bot[None, :] - yy + 0.8, 0, 1)
    a *= 0.8 + 0.2 * np.clip(rng.normal(0, 1, (H, 1)) * 0.6 + 1, 0, 1.4) / 1.4   # streaks along the stroke
    ends = np.clip(np.minimum(xs, w - 1 - xs) / 5.0, 0, 1) ** 0.6
    pool = 1 + 0.18 * np.exp(-xs / 14.0) + 0.14 * np.exp(-(w - 1 - xs) / 10.0)   # ink pools at the start and the lift
    over = 1 + 0.16 * (xs > w * rng.uniform(0.72, 0.86))                          # the second pass over the end
    a *= (ends * pool * over)[None, :]
    im = np.zeros((H, w, 4), np.uint8)
    im[..., :3] = rgb
    im[..., 3] = np.clip(a * 0.62 * 255, 0, 255).astype(np.uint8)
    return Image.fromarray(im, 'RGBA'), pad
