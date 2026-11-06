"""Helper for lane ch2 (not an event): the particle-to-picture engine behind scoop_form and molecule_scoop (6:21 round 2).
Each particle carries the colour of the pixel it will land on in a target picture; it starts in a loose field given by
the caller (drifting motes, or the atoms of real molecules), flies in on an eased spring with a mid-flight curve and a
per-particle delay (the cone first, bottom up), and the picture resolves solid (with its own light and shadow) as the last
ones land. On the exit word the finished picture slides out of frame in one piece, with motion blur. Moving particles
are drawn as soft streaks over their last frame (motion blur); particles are drawn at quarter-pixel precision with cv2
anti-aliasing.

    form(self, sid, e, pic, tx, ty, col, loose_xy, loose_col, loose_alpha, size, rng) -> time the picture is solid
      pic         RGBA uint8 target picture, placed at e['box']
      tx, ty, col where each particle lands and its colour there (targets())
      loose_xy    tt -> (x, y) arrays: where each particle is before it flies
      loose_col   (n, 3) colour while loose; it turns into the picture's colour as it lands
      loose_alpha tt -> (n,) opacity while loose
"""
import math
import numpy as np
import cv2
from PIL import Image
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, compass, ease_in
from overlay.helpers.motion_smear import FRAME_S, smear
SPREAD = 0.32  # seconds between the first particle (cone tip) and the last (top of the scoop) leaving


def _ease_out_back(u, k=1.1):
    u = np.clip(u, 0, 1)
    return 1 + (k + 1) * (u - 1) ** 3 + k * (u - 1) ** 2


def targets(pic, box, n, rng):
    """n landing points over the picture's opaque pixels, and each one's colour."""
    a = pic[..., 3].astype(np.float32) / 255
    ys, xs = np.nonzero(a > 0.6)
    pick = rng.choice(len(xs), n, replace=len(xs) < n)
    tx = xs[pick].astype(np.float32) + box[0] + rng.uniform(-0.5, 0.5, n)
    ty = ys[pick].astype(np.float32) + box[1] + rng.uniform(-0.5, 0.5, n)
    return tx, ty, pic[ys[pick], xs[pick], :3].astype(np.float32)


def form(self, sid, e, pic, tx, ty, col, loose_xy, loose_col, loose_alpha, size, rng):
    n = len(tx)
    bx0, by0, bx1, by1 = e['box']
    H = by1 - by0
    ph = rng.uniform(0, 2 * math.pi, n)
    delay = SPREAD * (1 - (ty - by0) / H) * 0.8 + rng.uniform(0, SPREAD * 0.2, n)
    t_in, t_as, t_out = self.T(e['at']), self.T(e['assemble_at']), self.T(e['out'])
    fly = e.get('assemble_s', 1.0) - SPREAD
    t_solid = t_as + SPREAD + fly  # every particle has landed
    ox, oy = compass(e.get('out_dir', 'E'))
    solid_sh, sh_pad = stage.shadowed(Image.fromarray(pic, 'RGBA'), {'dx': 0, 'dy': 10, 'blur': 22, 'opacity': 0.45})

    def state(tt):
        wx, wy = loose_xy(tt)
        u = np.clip((tt - t_as - delay) / fly, 0, 1)
        k = _ease_out_back(u)
        bend = np.sin(np.pi * u) * 40  # a curved flight, strongest mid-way
        return wx + (tx - wx) * k + bend * np.cos(ph), wy + (ty - wy) * k + bend * np.sin(ph) * 0.5, np.clip(u * 1.4, 0, 1)

    def slide(tt):
        v = ease_in((tt - t_out) / 0.45) if tt >= t_out else 0.0
        return (None, None) if v >= 1 else (ox * v, oy * v)  # compass(): long enough to leave the frame

    def particles(tt):
        x, y, mix = state(tt)
        xp, yp, _ = state(max(t_in, tt - FRAME_S))
        s_in = float(np.clip((tt - (t_solid - 0.12)) / 0.25, 0, 1))
        dots_a = (loose_alpha(tt) * (1 - mix) + mix) * (1 - s_in)
        X0 = int(max(-80, min(x.min(), xp.min(), bx0) - 30 - sh_pad))
        Y0 = int(max(-80, min(y.min(), yp.min(), by0) - 30 - sh_pad))
        X1 = int(min(stage.W + 80, max(x.max(), xp.max(), bx1) + 30 + sh_pad))
        Y1 = int(min(stage.H + 80, max(y.max(), yp.max(), by1) + 30 + sh_pad))
        canvas = np.zeros((Y1 - Y0, X1 - X0, 4), np.uint8)
        c = loose_col * (1 - mix[:, None]) + col * mix[:, None]
        for i in np.argsort(ty):  # top to bottom, so lower particles overlap like the picture
            al = dots_a[i]
            if al <= 0.02:
                continue
            p0 = (int(round((x[i] - X0) * 4)), int(round((y[i] - Y0) * 4)))
            p1 = (int(round((xp[i] - X0) * 4)), int(round((yp[i] - Y0) * 4)))
            colour = (int(c[i, 0]), int(c[i, 1]), int(c[i, 2]), int(255 * al))
            rr = size[i] * (0.75 + 0.25 * mix[i])  # loose particles are a little smaller than landed ones
            if abs(p0[0] - p1[0]) + abs(p0[1] - p1[1]) > 24:  # moving: a thin, faint streak over its last frame
                cv2.line(canvas, p1, p0, colour[:3] + (int(colour[3] * 0.45),), max(1, int(round(rr))), cv2.LINE_AA, shift=2)
            cv2.circle(canvas, p0, int(round(rr * 4)), colour, -1, cv2.LINE_AA, shift=2)
        img = Image.fromarray(canvas, 'RGBA')
        if s_in > 0.01:  # the solid picture goes under the last particles
            under = Image.new('RGBA', img.size, (0, 0, 0, 0))
            s = solid_sh.copy()
            s.putalpha(s.getchannel('A').point(lambda v: int(v * s_in)))
            under.alpha_composite(s, (int(bx0 - sh_pad - X0), int(by0 - sh_pad - Y0)))
            under.alpha_composite(img)
            img = under
        img, p = stage.shadowed(img, {'dx': 0, 'dy': 2, 'blur': 5, 'opacity': 0.35 * (1 - s_in)})  # pale motes read over the window
        return img, X0 - p, Y0 - p

    def dyn(tt):
        if tt < t_in:
            return None, 0, 0
        if tt < t_solid + 0.2:
            return particles(tt)
        dx, dy = slide(tt)  # held solid, then out in one piece
        if dx is None:
            return None, 0, 0
        x, y = bx0 - sh_pad + dx, by0 - sh_pad + dy
        d0 = slide(tt - 1.5 * FRAME_S)
        if tt > t_out and d0[0] is not None:
            return smear(solid_sh, x, y, dx - d0[0], dy - d0[1])
        return solid_sh, x, y

    sp = SmoothSprite(self, sid, None, 0, 0, t_in, 'none', 0, order=60, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    return t_solid
