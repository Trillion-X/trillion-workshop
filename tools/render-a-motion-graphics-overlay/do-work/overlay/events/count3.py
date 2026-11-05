"""The `count3` event. Ported from filmcraft/options-ch1/tools-round-3/r3.py:543."""
import math
import numpy as np
from PIL import Image, ImageDraw

from overlay import kit, look, stage


# ---------- odometer count-up ----------
def ev_count3(self, e):
    """The number rolls like an odometer from 0 to e.value between e.at and e.end (e.ease: a number is an ease-out
    power, {"in_out": p} eases in and out); every column scrolls, the fast ones blurred by a half-frame shutter, so every number passes. White SF
    Pro Display Heavy with the soft wide drop shadow, no shake. The unit lands on e.unit_at."""
    fnum = kit.sf('display_heavy', e.get('num_px', 170))
    funit = kit.sf('display_semibold', e.get('unit_px', 66))
    t0, t1, tu = self.T(e['at']), self.T(e['end']), self.T(e['unit_at'])
    value, power = e['value'], e.get('ease', 2.4)
    nd = len(str(value))
    cw = int(max(fnum.getlength(str(d)) for d in range(10)))
    asc, desc = fnum.getmetrics()
    lh = int(asc * 1.02)
    top = int(asc * 0.24)  # cap top inside the ascent box
    W_ = nd * cw + 24 + int(funit.getlength(e['unit'])) + 20
    H_ = asc + desc + 10
    digit_strip = {}

    def v_at(tt):
        u = min(max((tt - t0) / (t1 - t0), 0.0), 1.0)
        if isinstance(power, dict):  # {"in_out": p}: slow start, fast middle, slow finish
            q = power['in_out']
            return value * (0.5 * (2 * u) ** q if u < 0.5 else 1 - 0.5 * (2 * (1 - u)) ** q)
        return value * (1 - (1 - u) ** power)  # ease-out: fast start, eases into the finish

    def column_pos(v, k):
        if k == 0:
            return v
        unit = 10 ** k
        frac = min(max((v % unit) - (unit - 1), 0.0), 1.0)
        return math.floor(v / unit) + frac

    def glyph(d):
        if d not in digit_strip:
            im = Image.new('L', (cw, lh), 0)
            if d is not None:
                ImageDraw.Draw(im).text((cw / 2, asc - top + 4), str(d), font=fnum, fill=255, anchor='ms')
            digit_strip[d] = np.asarray(im).astype(np.float32)
        return digit_strip[d]
    win = np.ones((lh, 1), np.float32)
    fade = int(lh * 0.14)
    win[:fade, 0] = np.linspace(0, 1, fade)
    win[-fade:, 0] = np.linspace(1, 0, fade)

    def number_alpha(v):
        a = np.zeros((lh, nd * cw), np.float32)
        for k in range(nd):
            pos = column_pos(v, k)
            d0, off = int(math.floor(pos)), pos - math.floor(pos)
            lead = k > 0 and v < 10 ** k - 1e-9
            g0 = None if (lead and d0 % 10 == 0 and d0 < 10) else d0 % 10
            g1 = (d0 + 1) % 10
            y = int(round(off * lh))
            col_im = np.zeros((lh, cw), np.float32)
            if y < lh:
                col_im[:lh - y] += glyph(g0)[y:]
            if y > 0:
                col_im[lh - y:] += glyph(g1)[:y]
            x = (nd - 1 - k) * cw
            a[:, x:x + cw] = np.maximum(a[:, x:x + cw], col_im)
        return a * win
    cache = {}

    def render(tt):
        key = round(tt * stage.FPS)
        if key in cache:
            return cache[key]
        dt = 1.0 / stage.FPS
        samples = [v_at(tt - dt * 0.5 * s / 7) for s in range(8)]  # 180-degree shutter: blur over half a frame
        a = sum(number_alpha(v) for v in samples) / len(samples)
        im = Image.new('RGBA', (W_, H_), (0, 0, 0, 0))
        im.paste((255, 255, 255, 255), (0, top - 4), Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)))
        if tt >= tu:
            ImageDraw.Draw(im).text((nd * cw + 24, 5 + asc), e['unit'], font=funit, fill=(255, 255, 255, 255), anchor='ls')
        out = stage.shadowed(im, dict(look.LOOK['text_shadow'], **e.get('shadow', {})))
        cache.clear()
        cache[key] = out
        return out
    im0, pad0 = render(t1 + 1)
    self.safe_box(e.get('id', 'count'), *self.opaque_box(im0, e['pos'][0] - pad0, e['pos'][1] - pad0), t0)

    def dyn(tt):
        im, pad = render(tt)
        return im, e['pos'][0] - pad, e['pos'][1] - pad
    sp = kit.SmoothSprite(self, e.get('id', 'count'), None, 0, 0, t0, 'none', 0, order=60, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    kind = 'roll-' + e.get('id', 'count')
    self.extra_sounds[kind] = [{'file': self.roll_sound(kind, v_at, t0, t1, value, e), 'gain_db': 0}]
    self.sound(kind, t0)
