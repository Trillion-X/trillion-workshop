"""The `brush` event. Ported from filmcraft/options-ch1/tools-round-2/r2.py:392."""
import numpy as np
from PIL import Image

from overlay import kit, stage


# ---------- red brush strike ----------
def ev_brush(self, e):
    """One bright red textured-brush stroke per line in e.lines ([x0, y_centre, x1] in frame px), each drawn across
    in draw_s, the next starting stagger_s later."""
    t0 = self.T(e['at'])
    draw = e.get('draw_s', 0.22)
    for k, (x0, yc, x1) in enumerate(e['lines']):
        stroke, pad = kit.brush_stroke(x1 - x0, e.get('height', 34), 40 + k * 7, kit.col('accent_red'))
        rot = e.get('rot', [-2.5, 1.8, -1.2][k % 3])
        stroke = stroke.rotate(rot, expand=True, resample=Image.BICUBIC)
        t = t0 + k * e.get('stagger_s', 0.16)
        sx, sy = x0 - pad - (stroke.width - (x1 - x0 + 2 * pad)) / 2, yc - stroke.height / 2
        cache = {}

        def dyn(tt, stroke=stroke, t=t, sx=sx, sy=sy, cache=cache):
            fr = round(min(1.0, stage.ease_out((tt - t) / draw)), 2)
            if fr not in cache:
                im = stroke.copy()
                a = np.asarray(im.getchannel('A')).copy()
                cut = int(im.width * fr)
                a[:, cut:] = 0
                im.putalpha(Image.fromarray(a))
                cache[fr] = im
            return cache[fr], sx, sy
        sp = stage.Sprite(e.get('id', 'brush') + f'-{k}', None, 0, 0, t, 'none', 0, order=e.get('order', 70), jitter=False)
        sp.dynamic = dyn
        if e.get('until') is not None:
            sp.until = self.T(e['until'])
        self.add(sp)
        self.sound('brush', t)
