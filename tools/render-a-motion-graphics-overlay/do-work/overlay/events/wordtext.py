"""The `wordtext` event. Ported from filmcraft/options-ch1/tools-round-2/r2.py:182."""

from overlay import kit, stage


def ev_wordtext(self, e):
    """White SF Pro words over footage: soft wide drop shadow, rise 12 px and fade in over 0.14 s, no shake."""
    fnt = kit.sf(e.get('font', 'display_bold'), e['size'])
    im, pad = kit.text_img(e['text'], fnt, kit.col(e.get('colour', 'white')), shadow=True, align=e.get('align', 'left'))
    t = self.T(e['at'])
    x = e['pos'][0] - pad
    y = e['pos'][1] - pad
    sp = stage.Sprite(e.get('id', 'word'), im, x, y, t, 'fade', 0.14, order=e.get('order', 60), jitter=False)
    base_y = y

    def dyn(tt, sp=sp):
        u = stage.ease_out((tt - t) / 0.16)
        return im, x, base_y + (1 - u) * 12
    sp.dynamic = dyn
    if e.get('until') is not None:
        sp.until = self.T(e['until'])
    self.add(sp)
    if e.get('sound', 'word_in'):
        self.sound(e.get('sound', 'word_in'), t)
    return sp
