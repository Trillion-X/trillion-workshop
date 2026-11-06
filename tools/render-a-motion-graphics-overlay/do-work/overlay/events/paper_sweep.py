"""The `paper_sweep` event: a sheet of paper sweeps up from the bottom of the frame and covers it, with a ragged top edge.
Ported from narrator/tools/render_correction.py:313, with opt_overlay.py:50's change: the sheet is built 24 px wider than
the frame, because a zig-zag that ends at x = W leaves the last pixel column partly open."""
import numpy as np
from PIL import Image, ImageDraw

from overlay import look, stage


def ev_paper_sweep(self, e):
    p = look.R['paper_sweep']
    width = stage.W + 24
    rng = np.random.default_rng(17)
    amp_hi = p['edge_amp_px'][1] * stage.K
    h = int(stage.H + amp_hi * 2)
    img = Image.new('RGBA', (width, h), (0, 0, 0, 0))
    pts, x = [], 0.0
    while x < width + 1:
        pts.append((x, amp_hi + rng.uniform(-1, 1) * rng.uniform(*p['edge_amp_px']) * stage.K))
        x += rng.uniform(*p['edge_period_px']) * stage.K / 2
    pts += [(width, h), (0, h)]
    ImageDraw.Draw(img).polygon(pts, fill=stage.rgb(p['colour']) + (255,))
    img = stage.apply_texture(img, 'sheet', 21)
    img, pad = stage.shadowed(img, {'dx': 0, 'dy': -6, 'blur': 14, 'opacity': 0.35})
    t = self.T(e['at'])
    top = -amp_hi * 2 - pad
    sp = stage.Sprite('paper', img, -pad, top, t, 'none', 0, order=10, jitter=False)

    def dyn(tt, sp=sp, t=t, top=top, img=img):
        v = stage.ease_out((tt - t) / p['sweep_s'])
        return img, -pad, top + (1 - v) * (stage.H + amp_hi * 3 + pad)
    sp.dynamic = dyn
    self.add(sp)
    self.paper = sp
    self.sound('paper', t)
