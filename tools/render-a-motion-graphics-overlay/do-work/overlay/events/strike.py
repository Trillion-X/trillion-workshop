"""The `strike` event. Ported from narrator/tools/render_correction.py:454."""
import math
import numpy as np
from PIL import Image, ImageDraw

from overlay import look, stage


def ev_strike(self, e):
    tgt = self.byid(e['target'])[-1]
    ms = look.R['marker_strike']
    bw, bh = tgt.img.size
    rng = np.random.default_rng(9)
    x0, y0 = tgt.x + bw * 0.12, tgt.y + bh * 0.3
    x1, y1 = tgt.x + bw * 0.88, tgt.y + bh * 0.7
    pts = []
    for i in range(ms['passes']):
        yy = y0 + (y1 - y0) * i / max(1, ms['passes'] - 1) + rng.normal(0, 4 * stage.K)
        pts += [(x0 + rng.normal(0, 8 * stage.K), yy), (x1 + rng.normal(0, 8 * stage.K), yy + rng.normal(0, 10 * stage.K))] if i % 2 == 0 else \
               [(x1 + rng.normal(0, 8 * stage.K), yy), (x0 + rng.normal(0, 8 * stage.K), yy + rng.normal(0, 10 * stage.K))]
    t = self.T(e['at'])
    cache = {}

    def dyn(tt):
        fr = round(min(1.0, (tt - t) / ms['draw_s']), 2)
        if fr not in cache:
            img = Image.new('RGBA', (stage.W, stage.H), (0, 0, 0, 0))
            seg = max(2, int(math.ceil(len(pts) * fr)))
            ImageDraw.Draw(img).line(pts[:seg], fill=stage.rgb(ms['colour']) + (235,), width=int(ms['stroke_px'] * stage.K), joint='curve')
            bb = img.getbbox()
            cache[fr] = (img.crop(bb), bb[0], bb[1]) if bb else (None, 0, 0)
        return cache[fr]
    sp = stage.Sprite(e.get('id', 'strike'), None, 0, 0, t, 'none', 0, order=55)
    sp.dynamic = dyn
    sp.moves = tgt.moves
    self.add(sp)
    self.sound('marker', t)
