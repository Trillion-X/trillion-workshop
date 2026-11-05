"""The `sfname` event. Ported from filmcraft/options-ch1/tools-round-2/r2.py:157."""
from PIL import Image

from overlay import kit, look, stage


# ---------- type ----------
def ev_sfname(self, e):
    fnt = kit.sf(e.get('font', 'display_bold'), e['size'])
    colour = kit.col(e.get('colour', 'ink'))
    t = self.T(e['at'])
    cps = e.get('cps', look.R['type_on']['chars_per_s'])
    text = e['text']
    until = self.T(e['until']) if e.get('until') is not None else None
    cache = {}

    def dyn(tt):
        n = min(len(text), int((tt - t) * cps) + 1)
        if n not in cache:
            im, _ = kit.text_img(text[:n] if n < len(text) else text, fnt, colour, shadow=False)
            if e.get('rot'):
                im = im.rotate(e['rot'], expand=True, resample=Image.BICUBIC)
            cache[n] = im
        return cache[n], e['pos'][0], e['pos'][1]
    sp = stage.Sprite(e.get('id', 'sfname'), None, 0, 0, t, 'none', 0, order=e.get('order', 22), jitter=False)
    sp.dynamic = dyn
    sp.until = until
    self.add(sp)
    self.sound('key', t)
    if len(text) > 18:
        self.sound('key', t + 0.9)
