"""The `pause` event. Ported from narrator/tools/render_correction.py:251."""
from PIL import Image, ImageDraw

from overlay import look, stage


# -- pause badge (a reference creator's paused aside)
def ev_pause(self, e):
    p = look.R['pause_badge']
    s = int(p['size_px'] * stage.K)
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    bw, gap, rr = s * p['bar_w_frac'], s * p['gap_frac'], s * p['radius_frac']
    x0 = (s - 2 * bw - gap) / 2
    for i in range(2):
        d.rounded_rectangle([x0 + i * (bw + gap), s * 0.1, x0 + i * (bw + gap) + bw, s * 0.9], rr, fill=stage.rgb('sticker_outline') + (255,))
    img, pad = stage.shadowed(img, {'dx': 0, 'dy': 3, 'blur': 10, 'opacity': 0.45})
    t = self.T(e['at'])
    sp = self.add(stage.Sprite('pause', img, stage.W / 2 - img.width / 2, stage.H / 2 - img.height / 2, t, 'pop', p['in_s'], order=90, jitter=False))
    sp.until = t + p['in_s'] + p['hold_s']
    self.sound('pause', t)
