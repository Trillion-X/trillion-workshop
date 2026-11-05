"""The `count` event. Ported from filmcraft/options-ch1/tools-round-2/r2.py:498."""
from PIL import Image, ImageDraw

from overlay import kit, look, stage


# ---------- count-up ----------
def ev_count(self, e):
    """'488 calories': the number counts up from 0 on e.at, the unit appears on e.unit_at; white SF Pro Display,
    soft wide drop shadow, no shake."""
    fnum = kit.sf('display_heavy', e.get('num_px', 190))
    funit = kit.sf('display_semibold', e.get('unit_px', 72))
    t = self.T(e['at'])
    tu = self.T(e['unit_at'])
    cs = e.get('count_s', 0.8)
    cache = {}
    w_final = fnum.getlength(str(e['value']))

    def render(sv, show_unit):
        key = (sv, show_unit)
        if key not in cache:
            asc, desc = fnum.getmetrics()
            ua, ud = funit.getmetrics()
            W_ = int(w_final + 24 + funit.getlength(e['unit']) + 20)
            H_ = asc + desc + 10
            im = Image.new('RGBA', (W_, H_), (0, 0, 0, 0))
            d = ImageDraw.Draw(im)
            d.text((w_final, 5 + asc), sv, font=fnum, fill=(255, 255, 255, 255), anchor='rs')
            if show_unit:
                d.text((w_final + 24, 5 + asc), e['unit'], font=funit, fill=(255, 255, 255, 255), anchor='ls')
            cache[key] = stage.shadowed(im, look.LOOK['text_shadow'])
        return cache[key]

    def dyn(tt):
        v = e['value'] * stage.ease_out((tt - t) / cs)
        img, pad = render(str(int(round(v))), tt >= tu)
        return img, e['pos'][0] - pad, e['pos'][1] - pad
    sp = stage.Sprite(e.get('id', 'count'), None, 0, 0, t, 'fade', 0.12, order=60, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('word_in', t)
    for i in range(6):
        self.sound('count_tick', t + i * cs / 6 * (1 + i * 0.1))
