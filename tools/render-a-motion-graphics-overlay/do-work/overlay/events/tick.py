"""The `tick` event. Ported from filmcraft/options-ch1/tools/opt_overlay.py:73."""
import math
from PIL import Image, ImageDraw

from overlay import stage


def ev_tick(self, e):
    """Marker tick drawn on in 0.2 s at pos (top-left), size px."""
    t, s = self.T(e['at']), e.get('size', 70)
    x0, y0 = e['pos']
    pts = [(x0, y0 + s * 0.55), (x0 + s * 0.35, y0 + s), (x0 + s, y0)]
    cache = {}

    def dyn(tt):
        fr = round(min(1.0, (tt - t) / 0.2), 2)
        if fr not in cache:
            img = Image.new('RGBA', (stage.W, stage.H), (0, 0, 0, 0))
            L1 = math.dist(pts[0], pts[1]); L2 = math.dist(pts[1], pts[2]); d = fr * (L1 + L2)
            path = [pts[0]]
            if d <= L1:
                path.append(tuple(pts[0][i] + (pts[1][i] - pts[0][i]) * d / L1 for i in (0, 1)))
            else:
                path += [pts[1], tuple(pts[1][i] + (pts[2][i] - pts[1][i]) * (d - L1) / L2 for i in (0, 1))]
            ImageDraw.Draw(img).line(path, fill=stage.rgb(e.get('colour', 'role_green')) + (255,), width=int(s * 0.16), joint='curve')
            bb = img.getbbox()
            cache[fr] = (img.crop(bb), bb[0], bb[1]) if bb else (None, 0, 0)
        return cache[fr]
    sp = stage.Sprite(e.get('id', 'tick'), None, 0, 0, t, 'none', 0, order=76)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('marker', t)
