"""bottle_drop (lane ch2, round 2): real objects from his own photos drop into the frame and land standing on a real
surface in his shot (the kitchen island), with gravity, a small damped bounce, a rocking settle and a contact shadow
that tightens as each one nears the surface; then they slide off the way they are nearest to, with motion blur
(the person's rules synthetic-0caa1e24e438, synthetic-4015c76f9424, synthetic-a22c9a75dcb4; filmcraft/options-ch2/techniques/bottle-drop.md).

    {"type": "bottle_drop", "id": "pills", "floor_y": 900, "out_at": s, "out_dir": "E", "out_stagger_s": 0.07,
     "items": [{"image": "bottle.png" (RGBA cut-out), "x": 1500 (centre), "h": 300, "at": s (lands), "fall_px": 700}]}

Times: `at` is the landing, so the knock sound sits on the frame it hits. The fall takes sqrt(2 fall_px / g) with g in
px/s^2 chosen so a 700 px fall takes 0.36 s (real 1.2 m in 0.5 s, scaled to a 2.2x faster screen read)."""
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from overlay.kit import SmoothSprite, compass, ease_in
from overlay.helpers.motion_smear import smeared
from overlay.helpers.sound_classes import play

G = 2 * 700 / 0.36 ** 2  # px/s^2
REST = 0.22              # bounce restitution
ROCK_S = 0.5             # rocking settle after the first contact


def _shadow(w):
    h = max(6, int(w * 0.16))
    im = Image.new('L', (int(w * 1.5), h * 3), 0)
    ImageDraw.Draw(im).ellipse([w * 0.25, h, w * 1.25, h * 2], fill=150)
    return im.filter(ImageFilter.GaussianBlur(h * 0.45))


def _pos(t, t_land, fall_px):
    """(height above the floor in px, rocking angle in degrees) at t; None before it enters."""
    t_fall = math.sqrt(2 * fall_px / G)
    if t < t_land - t_fall:
        return None
    if t < t_land:
        dt = t_land - t
        return 0.5 * G * dt * dt, 0.0
    v = G * t_fall * REST  # first bounce
    s = t - t_land
    up = v / G * 2
    if s < up:
        h = v * s - 0.5 * G * s * s
    else:
        h = 0.0
    rock = 4.0 * math.exp(-s * 7) * math.sin(s * 2 * math.pi / 0.22) if s < ROCK_S else 0.0
    return max(0.0, h), rock


def ev_bottle_drop(self, e):
    sid = e.get('id', 'drop')
    floor = e['floor_y']
    t_out0 = self.T(e['out_at'])
    ox, oy = compass(e.get('out_dir', 'E'))
    for k, it in enumerate(e['items']):
        src = Image.open(it['image']).convert('RGBA')
        h = it['h']
        im = src.resize((max(1, int(src.width * h / src.height)), h), Image.LANCZOS)
        sh = _shadow(im.width)
        t_land = self.T(it['at'])
        fall_px = it.get('fall_px', 700)
        cx = it['x']
        t_out = t_out0 + k * e.get('out_stagger_s', 0.07)
        x0, y0 = cx - im.width / 2, floor - im.height
        self.safe_box(f'{sid}{k}', x0, y0, x0 + im.width, floor, t_land, t_out)

        def leave(tt, t_out=t_out):
            if tt < t_out:
                return 0.0, 0.0
            u = ease_in((tt - t_out) / 0.42)
            return (None, None) if u >= 1 else (ox * u * 2200, oy * u * 2200)

        def dyn(tt, im=im, sh=sh, t_land=t_land, fall_px=fall_px, cx=cx, leave=leave):
            p = _pos(tt, t_land, fall_px)
            if p is None:
                return None, 0, 0
            dx, dy = leave(tt)
            if dx is None:
                return None, 0, 0
            lift, rock = p
            body = im if abs(rock) < 0.05 else im.rotate(rock, resample=Image.BICUBIC, center=(im.width / 2, im.height))
            near = max(0.0, 1.0 - lift / 400.0)  # the shadow darkens and tightens as it nears the surface
            canvas_h = int(im.height + lift + sh.height)
            c = Image.new('RGBA', (sh.width, canvas_h), (0, 0, 0, 0))
            if near > 0.02:
                s_im = sh.resize((max(1, int(sh.width * (0.6 + 0.4 * near))), sh.height))
                a = s_im.point(lambda v: int(v * near))
                blk = Image.new('RGBA', s_im.size, (0, 0, 0, 255))
                blk.putalpha(a)
                c.alpha_composite(blk, ((sh.width - s_im.width) // 2, canvas_h - sh.height))
            c.alpha_composite(body, ((sh.width - body.width) // 2, int(canvas_h - sh.height / 2 - lift - body.height)))
            return c, cx - sh.width / 2 + dx, floor - (canvas_h - sh.height / 2) + dy

        def travel(tt, t_land=t_land, fall_px=fall_px, leave=leave):  # what the smear follows: the fall, then the exit
            p = _pos(tt, t_land, fall_px)
            dx, dy = leave(tt)
            if p is None or dx is None:
                return 0.0, 0.0
            return dx, dy - p[0]
        sp = SmoothSprite(self, f'{sid}{k}', None, 0, 0, t_land - math.sqrt(2 * fall_px / G), 'none', 0, order=64 + k, jitter=False)
        sp.dynamic = smeared(dyn, travel)
        self.add(sp)
        play(self, 'ch2_lock', t_land)
    play(self, 'ch2_out', t_out0)
