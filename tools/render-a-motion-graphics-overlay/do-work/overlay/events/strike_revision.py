"""strikethrough-revision: what he thought, corrected in front of you (3blue1brown visual-design-catalog #19, MIT: the old value
stays visible with one red line through it and the corrected value is set beside it). White SF Pro over the footage: the
subject lands on its word, the old belief on its word, then one bright red textured-brush stroke crosses the old belief on the
word that corrects it, and the correction lands under it. All of it rises out together.

Spec: {type: revision, id, pos: [x, y], size, at, out, head: {text, at}, old: {text, at}, new: {text, at}, strike_at}"""
from overlay import kit, stage
from overlay.helpers import marker_and_slide as L


def ev_revision(self, e):
    big = kit.sf('display_bold', e['size'])
    mid = kit.sf('display_semibold', int(e['size'] * 0.72))
    x, y = e['pos']
    t_out = self.T(e['out'])
    lh = int(e['size'] * 1.25)
    parts = [(e['head'], big, y), (e['old'], mid, y + lh), (e['new'], mid, y + lh + int(e['size'] * 0.95))]
    placed = []
    for k, (p, fnt, yy) in enumerate(parts):
        im, pad = kit.text_img(p['text'], fnt, L.col('white'), shadow=True)
        t = self.T(p['at'])
        xx, yy0 = x - pad, yy - pad
        self.safe_box(f"{e.get('id', 'rev')}-{k}", *self.opaque_box(im, xx, yy0), t, t_out)
        placed.append((im, pad, xx, yy0))

        def dyn(tt, im=im, xx=xx, yy0=yy0, t=t):
            if tt >= t_out:
                v = L.ease_in((tt - t_out) / 0.32)
                if v >= 1:
                    return None, 0, 0
                a = im.copy()
                a.putalpha(a.getchannel('A').point(lambda q: int(q * (1 - v))))
                return a, xx, yy0 - 24 * v
            u = L.ease_out((tt - t) / 0.2)
            return im, xx, yy0 + (1 - u) * 14
        sp = stage.Sprite(f"{e.get('id', 'rev')}-{k}", None, 0, 0, t, 'fade', 0.16, order=60, jitter=False)
        sp.dynamic = dyn
        self.add(sp)
        self.sound('word_in', t)
    asc, desc = mid.getmetrics()
    yc = y + lh + 6 + asc * 0.7  # through the middle of the lower-case letters, so the old word stays readable
    self.ev_brush({'id': e.get('id', 'rev') + '-strike', 'at': e['strike_at'], 'lines': [[x - 10, yc, x + 10 + mid.getlength(e['old']['text'])]],
                   'height': 15, 'draw_s': 0.32, 'rot': -2.0, 'until': e['out'], 'order': 61})
    self.sound('word_out', t_out)
