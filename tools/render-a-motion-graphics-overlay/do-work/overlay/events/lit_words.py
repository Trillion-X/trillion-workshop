"""lit-words: a short list of words set in a row in white SF Pro Display over the footage; all appear at once, dimmed, and each
lights to full white as he says it (title/concept decomposition, 3blue1brown visual-design-catalog #14, MIT: one word lit at a
time, the others grey). They rise out together when the thought ends.

Spec: {type: litwords, id, pos: [x, y], size, gap, column, at, out, words: [{text, at}], dim}
(column: true sets the words one under another, gap = line spacing in px)"""
from overlay import kit, stage
from overlay.helpers import marker_and_slide as L


def ev_litwords(self, e):
    fnt = kit.sf(e.get('font', 'display_bold'), e['size'])
    imgs = [kit.text_img(w['text'], fnt, L.col('white'), shadow=True) for w in e['words']]
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    dim = e.get('dim', 0.42)
    x, y = e['pos']
    for k, ((im, pad), w) in enumerate(zip(imgs, e['words'])):
        t_lit = self.T(w['at'])
        xx, yy = x - pad, y - pad
        self.safe_box(e.get('id', 'lit') + f'-{k}', *self.opaque_box(im, xx, yy), t_in, t_out)
        dimmed = im.copy()
        dimmed.putalpha(dimmed.getchannel('A').point(lambda p: int(p * dim)))

        def dyn(tt, im=im, dimmed=dimmed, xx=xx, yy=yy, t_lit=t_lit):
            a = im if tt >= t_lit else dimmed
            if tt >= t_out:
                v = L.ease_in((tt - t_out) / 0.32)
                if v >= 1:
                    return None, 0, 0
                a = a.copy()
                a.putalpha(a.getchannel('A').point(lambda p: int(p * (1 - v))))
                return a, xx, yy - 24 * v
            u = L.ease_out((tt - t_in) / 0.22)
            return a, xx, yy + (1 - u) * 14
        sp = stage.Sprite(e.get('id', 'lit') + f'-{k}', None, 0, 0, t_in, 'fade', 0.18, order=60, jitter=False)
        sp.dynamic = dyn
        self.add(sp)
        if e.get('column'):
            y += e.get('gap', int(e['size'] * 1.3))
        else:
            x += im.width - 2 * pad + e.get('gap', 56)
    self.sound('word_in', t_in)
    self.sound('word_out', t_out)
