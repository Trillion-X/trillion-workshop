"""The `scrap` event: a typewriter line on a torn paper scrap that slams in. With `blank` the scrap slams in empty (its ink
in the paper's colour) so a typepage can type onto it. Ported from narrator/tools/render_correction.py:445 and
opt_overlay.py:59 (blank)."""
from PIL import Image

from overlay import look, stage


def ev_scrap(self, e):
    self.seed += 1
    blank = e.get('blank')
    img = self.paper_text_img(e['text'], e['size'], e.get('paper', 'crumpled'), self.seed, **({'colour': 'paper_white'} if blank else {}))
    img = img.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC)
    img, pad = stage.shadowed(img, look.R['card']['shadow'])
    t = self.T(e['at'])
    self.add(stage.Sprite(e.get('id', 'scrap'), img, e['pos'][0] * stage.K - pad, e['pos'][1] * stage.K - pad, t, 'slam', look.R['card']['slam_s'], order=50))
    self.sound('paper', t)
