"""pull-quote: his sentence set as a quote in white SF Pro Display over the footage (soft wide drop shadow, no outline), whole
from its first frame, with one bright red textured-brush underline drawn under the key phrase on the word that says it.
Rises in on its first word, rises out when the thought ends.

Spec: {type: pullquote, id, pos: [x, y], lines: [...], size, font, at, out, leading,
       underline: {line, phrase, at, draw_s}}"""
from overlay import kit, stage
from overlay.helpers import marker_and_slide as L


def ev_pullquote(self, e):
    fnt = kit.sf(e.get('font', 'display_bold'), e['size'])
    text = '\n'.join(e['lines'])
    im, pad = kit.text_img(text, fnt, L.col('white'), shadow=True, leading=e.get('leading', 1.16))
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    x, y = e['pos'][0] - pad, e['pos'][1] - pad
    self.safe_box(e.get('id', 'quote'), *self.opaque_box(im, x, y), t_in, t_out)

    def dyn(tt):
        if tt >= t_out:
            v = L.ease_in((tt - t_out) / 0.32)
            if v >= 1:
                return None, 0, 0
            a = im.copy()
            a.putalpha(a.getchannel('A').point(lambda p: int(p * (1 - v))))
            return a, x, y - 26 * v
        u = L.ease_out((tt - t_in) / 0.22)
        return im, x, y + (1 - u) * 16
    sp = stage.Sprite(e.get('id', 'quote'), None, 0, 0, t_in, 'fade', 0.18, order=e.get('order', 60), jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('word_in', t_in)
    self.sound('word_out', t_out)
    ul = e.get('underline')
    if ul:
        asc, desc = fnt.getmetrics()
        lh = int((asc + desc) * e.get('leading', 1.16))
        line = e['lines'][ul['line']]
        i = line.index(ul['phrase'])
        x0 = e['pos'][0] + 6 + fnt.getlength(line[:i])
        x1 = x0 + fnt.getlength(ul['phrase'])
        yc = e['pos'][1] + 6 + ul['line'] * lh + asc + desc * 0.55
        self.ev_brush({'id': e.get('id', 'quote') + '-ul', 'at': ul['at'], 'lines': [[x0, yc, x1]], 'height': ul.get('height', 14),
                       'draw_s': ul.get('draw_s', 0.35), 'rot': -0.8, 'until': e['out'], 'order': e.get('order', 60) - 1})
