"""The `narrator_tag` event. Ported from narrator/tools/render_correction.py:266."""
from PIL import Image, ImageDraw

from overlay import look, stage


def ev_narrator_tag(self, e):
    f = stage.font(look.R['fonts']['typewriter'], 30 * stage.K)
    tw = f.getlength(e['text'])
    w, h = int(tw + 60 * stage.K), int(56 * stage.K)
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon(stage.torn_polygon(w, h, 4 * stage.K, 5, step=7 * stage.K), fill=stage.rgb('kraft') + (238,))
    d.text((30 * stage.K, h / 2), e['text'], font=f, fill=stage.rgb('ink') + (255,), anchor='lm')
    img = stage.apply_texture(img, 'kraft', 5).rotate(e.get('rot', 0), expand=True, resample=Image.BICUBIC)
    img, pad = stage.shadowed(img, look.R['card']['shadow'])
    sp = self.add(stage.Sprite('tag', img, e['pos'][0] * stage.K - pad, e['pos'][1] * stage.K - pad, self.T(e['at']), 'pop', 0.17, order=80))
    sp.until = self.T(e['until'])
    self.sound('pop3', sp.t_in)
