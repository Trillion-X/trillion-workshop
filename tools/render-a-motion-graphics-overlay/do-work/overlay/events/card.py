"""The `card` event. Ported from narrator/tools/render_correction.py:528."""
from PIL import Image, ImageDraw

from overlay import look, stage


def ev_card(self, e):
    im = Image.open(stage.P(e['image'])).convert('RGB').crop(tuple(e['crop']))
    cw = int(e['w'] * stage.K)
    ch_ = int(im.height * cw / im.width)
    im = im.resize((cw, ch_), Image.LANCZOS)
    c = look.R['card']
    b, cb = int(c['border_px'] * stage.K), int(c['caption_border_px'] * stage.K) if e.get('caption') else int(c['border_px'] * stage.K)
    card = Image.new('RGBA', (cw + 2 * b, ch_ + b + cb), stage.rgb('paper_white') + (255,))
    card.paste(im, (b, b))
    if e.get('caption'):
        size = 26 * stage.K
        fnt = stage.font(look.R['fonts']['typewriter'], size)
        while fnt.getlength(e['caption']) > cw - 2 * b and size > 12 * stage.K:
            size *= 0.94
            fnt = stage.font(look.R['fonts']['typewriter'], size)
        ImageDraw.Draw(card).text((card.width / 2, ch_ + b + cb / 2), e['caption'], font=fnt, fill=stage.rgb('ink') + (255,), anchor='mm')
    self.seed += 1
    card = stage.apply_texture(card, 'sheet', self.seed, 0.25)
    card = card.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC)
    card, pad = stage.shadowed(card, c['shadow'])
    t = self.T(e['at'])
    self.add(stage.Sprite(e.get('id', 'card'), card, e['pos'][0] * stage.K - pad, e['pos'][1] * stage.K - pad, t, 'slam', c['slam_s'], order=65))
    self.sound('shutter', t)
