"""soft_backing (lane ch1 cold opens, round 8): a soft dark panel behind a block of white type, so it reads over busy or bright parts of the picture on a
phone (text-colour-contrast). Feathered edges, no outline, under the type (order 70), fading in and out with the type it backs.

    {"type": "soft_backing", "id": "bk", "box": [x0, y0, x1, y1], "alpha": 0.5, "feather": 60, "at": s, "out": s, "fade_s": 0.25}
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from overlay import kit, look, stage
from overlay.kit import SmoothSprite



def ev_soft_backing(self, e):
    x0, y0, x1, y1 = e['box']
    feather = e.get('feather', 60)
    pad = feather * 2
    w, h = int(x1 - x0) + 2 * pad, int(y1 - y0) + 2 * pad
    m = Image.new('L', (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([pad, pad, w - pad, h - pad], radius=feather, fill=255)
    m = m.filter(ImageFilter.GaussianBlur(feather / 2))
    base = np.asarray(m, dtype=np.float32) / 255.0 * e.get('alpha', 0.5)
    t_in, t_out, fade = self.T(e['at']), self.T(e['out']), e.get('fade_s', 0.25)
    cache = {}

    def dyn(tt):
        if not (t_in <= tt < t_out + fade):
            return None, 0, 0
        k = round(min(1.0, (tt - t_in) / fade, max(0.0, 1 - (tt - t_out) / fade)), 2)
        if k not in cache:
            a = (base * k * 255).astype(np.uint8)
            im = Image.fromarray(np.dstack([np.zeros((h, w, 3), np.uint8), a]), 'RGBA')
            cache[k] = im
        return cache[k], x0 - pad, y0 - pad
    sp = SmoothSprite(self, e.get('id', 'backing'), None, 0, 0, t_in, 'none', 0, order=e.get('order', 70), jitter=False)
    sp.dynamic = dyn
    self.add(sp)
