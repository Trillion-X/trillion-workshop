"""The `name` event. Ported from narrator/tools/render_correction.py:351."""
from PIL import Image

from overlay import look, stage


def ev_name(self, e):
    fs = look.R['fonts']['name']
    cap = e.get('size_cap_frac', fs['cap_height_frac']) * stage.H
    fnt = stage.font(fs, cap / 0.727)
    track = fs['tracking_em'] * fnt.size
    rot = look.R['type_on']['rotation_deg']
    t = self.T(e['at'])
    cps = look.R['type_on']['chars_per_s']
    text = e['text']
    cache = {}

    def dyn(tt):
        n = min(len(text), int((tt - t) * cps) + 1)
        if n not in cache:
            im = self.type_on_img(text, fnt, stage.rgb('name_mint'), n, track).rotate(rot, expand=True, resample=Image.BICUBIC)
            cache[n] = im
        return cache[n], e['pos'][0] * stage.K, e['pos'][1] * stage.K
    sp = stage.Sprite('name', None, 0, 0, t, 'none', 0, order=20)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('key', t)
