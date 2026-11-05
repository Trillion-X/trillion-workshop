"""particle_assemble (lane ch2): loose dots (molecules) appear and drift on one word, then fly together into the shape of a
thing on another word, hold as that thing drawn in dots, and scatter out of frame (technique: particle assemble /
murmuration, 21st.dev block murmuration-logo; filmcraft/options-ch2/techniques/particle-assemble.md). White dots with the soft wide shadow
over footage; seeded, so every render is the same; every frame drawn.

    {"type": "particle_assemble", "id": "scoop", "n": 320, "seed": 7, "box": [x0, y0, x1, y1],      where the loose dots drift
     "shape": "ice_cream", "shape_box": [x0, y0, x1, y1],                                             the thing they become
     "at": s, "assemble_at": s, "assemble_s": 0.9, "out": s, "out_dir": "W"}
"""
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, compass, ease_in
from overlay.helpers.motion_smear import FRAME_S


def _ice_cream_mask(w, h):
    """Scoop (two bumps over a round top) on a cone, as a filled mask w x h."""
    m = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(m)
    sr = w * 0.40
    cx, cy = w / 2, sr + 4
    d.ellipse([cx - sr, cy - sr, cx + sr, cy + sr], fill=255)
    d.ellipse([cx - sr * 1.05, cy + sr * 0.25, cx - sr * 0.35, cy + sr * 0.85], fill=255)  # drip of the scoop's rim
    d.ellipse([cx + sr * 0.3, cy + sr * 0.3, cx + sr * 1.02, cy + sr * 0.82], fill=255)
    top = cy + sr * 0.62
    d.polygon([(cx - sr * 0.86, top), (cx + sr * 0.86, top), (cx, h - 2)], fill=255)
    return m


SHAPES = {'ice_cream': _ice_cream_mask}


def ev_particle_assemble(self, e):
    sid = e.get('id', 'particles')
    rng = np.random.default_rng(e.get('seed', 7))
    n = e.get('n', 320)
    x0, y0, x1, y1 = e['box']
    sx0, sy0, sx1, sy1 = e['shape_box']
    mask = np.asarray(SHAPES[e['shape']](int(sx1 - sx0), int(sy1 - sy0))) > 128
    ys, xs = np.nonzero(mask)
    edge = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).filter(ImageFilter.FIND_EDGES)) > 0
    eys, exs = np.nonzero(edge)
    k_edge = n * 2 // 5  # outline first so the shape reads, the rest fills it
    pick_e = rng.choice(len(exs), k_edge, replace=False)
    pick_f = rng.choice(len(xs), n - k_edge, replace=False)
    tx = np.concatenate([exs[pick_e], xs[pick_f]]).astype(float) + sx0
    ty = np.concatenate([eys[pick_e], ys[pick_f]]).astype(float) + sy0
    px, py = rng.uniform(x0, x1, n), rng.uniform(y0, y1, n)
    rad = rng.uniform(2.6, 4.6, n)
    ph = rng.uniform(0, 2 * math.pi, (n, 2))
    fr = rng.uniform(0.6, 1.4, n)
    appear = rng.uniform(0, 0.45, n)
    delay = rng.uniform(0, 0.25, n)
    t_in, t_as, t_out = self.T(e['at']), self.T(e['assemble_at']), self.T(e['out'])
    as_s = e.get('assemble_s', 0.9)
    ox, oy = compass(e.get('out_dir', 'W'))
    cxs, cys = (sx0 + sx1) / 2, (sy0 + sy1) / 2
    away = np.stack([tx - cxs, ty - cys], 1)
    away /= np.maximum(np.linalg.norm(away, axis=1, keepdims=True), 1)
    out_v = away * 500 + np.array([ox, oy]) * 1.2
    out_delay = rng.uniform(0, 0.15, n)
    self.safe_box(sid, min(x0, sx0), min(y0, sy0), max(x1, sx1), max(y1, sy1), t_in, t_out)

    def pos(tt):
        """Every dot's place at tt, and whether all have left the frame."""
        dt = tt - t_in
        wx = px + 18 * np.sin(0.9 * fr * dt + ph[:, 0])  # loose: a slow drift around each dot's own place
        wy = py + 14 * np.sin(0.7 * fr * dt + ph[:, 1])
        u = np.clip((tt - t_as - delay) / as_s, 0, 1)
        u = u * u * (3 - 2 * u)
        x = wx + (tx - wx) * u
        y = wy + (ty - wy) * u
        settled = u >= 1
        x = np.where(settled, tx + 1.2 * np.sin(2.2 * dt + ph[:, 0]), x)  # held: a faint shimmer
        y = np.where(settled, ty + 1.2 * np.sin(1.9 * dt + ph[:, 1]), y)
        if tt < t_out:
            return x, y, False
        v = np.array([ease_in(min(1.0, max(0.0, (tt - t_out - d) / 0.55))) for d in out_delay])  # scatter
        return x + out_v[:, 0] * v, y + out_v[:, 1] * v, bool((v >= 1).all())

    def dyn(tt):
        """Each dot is drawn as a streak over its last 1.5 frames of travel (motion blur), so fast dots stay continuous."""
        if tt < t_in:
            return None, 0, 0
        dt = tt - t_in
        x, y, gone = pos(tt)
        if gone:
            return None, 0, 0
        x_prev, y_prev, _ = pos(max(t_in, tt - 1.5 * FRAME_S))
        a = np.clip((dt - appear) / 0.2, 0, 1)
        X0, Y0 = int(min(x.min(), x_prev.min(), x0) - 20), int(min(y.min(), y_prev.min(), y0) - 20)
        X1, Y1 = int(max(x.max(), x_prev.max(), x1) + 20), int(max(y.max(), y_prev.max(), y1) + 20)
        X0, Y0, X1, Y1 = max(X0, -60), max(Y0, -60), min(X1, stage.W + 60), min(Y1, stage.H + 60)
        layer = Image.new('RGBA', (max(1, X1 - X0), max(1, Y1 - Y0)), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        for i in range(n):
            if a[i] <= 0:
                continue
            r = rad[i]
            c = (255, 255, 255, int(255 * a[i]))
            d.ellipse([x[i] - X0 - r, y[i] - Y0 - r, x[i] - X0 + r, y[i] - Y0 + r], fill=c)
            if abs(x[i] - x_prev[i]) + abs(y[i] - y_prev[i]) > 2:
                d.line([(x_prev[i] - X0, y_prev[i] - Y0), (x[i] - X0, y[i] - Y0)], fill=c, width=int(2 * r))
                d.ellipse([x_prev[i] - X0 - r, y_prev[i] - Y0 - r, x_prev[i] - X0 + r, y_prev[i] - Y0 + r], fill=c)
        img, p = stage.shadowed(layer, {'dx': 0, 'dy': 2, 'blur': 6, 'opacity': 0.5})
        return img, X0 - p, Y0 - p

    sp = SmoothSprite(self, sid, None, 0, 0, t_in, 'none', 0, order=60, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('word_in', t_in)
    self.sound('brush', t_as)
    self.sound('whoosh', t_out)
