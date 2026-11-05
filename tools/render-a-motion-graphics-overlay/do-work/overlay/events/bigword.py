"""The `bigword` event. Ported from filmcraft/options-ch1/tools/opt_overlay.py:130."""
from PIL import Image, ImageDraw

from overlay import look, stage


def ev_bigword(self, e):
    """Huge word(s) behind the speaker: text sprite under a person layer cut from the graded frames with per-frame mattes
    (frames/<n>.png + mattes/<n>.png, n = overlay frame index). Device: huge word behind the speaker."""
    t, until = self.T(e['at']), self.T(e['until'])
    fnt = stage.font(e.get('font', look.R['fonts']['ransom'][0]), e['size'])
    col = stage.rgb(e.get('colour', 'figure_cream'))
    asc, desc = fnt.getmetrics()
    img = Image.new('RGBA', (int(fnt.getlength(e['text']) + 40), asc + desc + 40), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((20, 20), e['text'], font=fnt, fill=col + (int(255 * e.get('alpha', 1.0)),))
    if e.get('rot'):
        img = img.rotate(e['rot'], expand=True, resample=Image.BICUBIC)
    x = e['pos'][0] if e['pos'][0] is not None else (stage.W - img.width) / 2
    sp = self.add(stage.Sprite(e.get('id', 'bigword'), img, x, e['pos'][1], t, e.get('intro', 'slam'), 0.12, order=5))
    sp.until = until
    self.sound(e.get('sound', 'pop'), t)
    self.person = e['person']  # dir with frames/ and mattes/
