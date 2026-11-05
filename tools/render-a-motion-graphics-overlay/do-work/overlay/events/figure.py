"""The `figure` event. Ported from narrator/tools/render_correction.py:578."""
from PIL import Image, ImageDraw

from overlay import look, stage


def ev_figure(self, e):
    bf = look.R['big_figure']
    fnum = stage.font(look.R['fonts']['figure'], e.get('size_px', bf['size_px']) * stage.K)
    flab = stage.font(look.R['fonts']['role'], bf['label_px'] * stage.K, weight=720)
    col = stage.rgb(e.get('colour', 'figure_cream'))
    t = self.T(e['at'])
    tc = self.T(e['count_at']) if e.get('count_at') else t
    cs = e.get('count_s', bf['count_s'])
    cache = {}

    def txt(s, f):
        asc, desc = f.getmetrics()
        im = Image.new('RGBA', (int(f.getlength(s) + 10), asc + desc + 10), (0, 0, 0, 0))
        ImageDraw.Draw(im).text((5, 5), s, font=f, fill=col + (255,))
        return im

    def dyn(tt):
        v = e['value_from'] + (e['value_to'] - e['value_from']) * stage.ease_out((tt - tc) / cs)
        s = e['fmt'].format(v) + e.get('suffix', '')
        if s not in cache:
            lab, num = txt(e['label'], flab), txt(s, fnum)
            sub = txt(e['sub'], flab) if e.get('sub') else None
            h = lab.height + num.height + (sub.height if sub else 0)
            im = Image.new('RGBA', (max(lab.width, num.width, sub.width if sub else 0), h), (0, 0, 0, 0))
            im.alpha_composite(lab, (int(8 * stage.K), 0)); im.alpha_composite(num, (0, int(lab.height * 0.75)))
            if sub:
                im.alpha_composite(sub, (int(8 * stage.K), int(lab.height * 0.75 + num.height * 0.92)))
            img, pad = stage.shadowed(im, {'dx': 0, 'dy': 4, 'blur': bf['shadow']['blur'], 'opacity': e.get('shadow_opacity', bf['shadow']['opacity'])})
            cache[s] = (img, pad)
        img, pad = cache[s]
        return img, e['pos'][0] * stage.K - pad, e['pos'][1] * stage.K - pad
    sp = stage.Sprite(e.get('id', 'figure'), None, 0, 0, t, 'pop', 0.17, order=60)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('pop', t)
    for i in range(8):
        self.sound('tick', tc + i * cs / 8 * (1 + i * 0.12))
