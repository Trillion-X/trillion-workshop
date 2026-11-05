"""glass_fill (lane ch3): a glass drawn in white marker over the footage fills layer by layer, one layer per thing he names,
each layer carrying its own name; a straw drops in on the format's name (technique: fixed shape, swapping fill, from the
devices library; filmcraft/options-ch3/TECHNIQUES.md#glass-fill-layers).

    {"type": "glass_fill", "id": "glass", "pos": [x, y], "w": 220, "h": 360, "at": s, "out": s,
     "layers": [{"label": "nutrients", "colour": "paper_cream", "at": s}, ...], "straw_at": s}

White marker lines with the soft wide shadow over the dark backsplash; layer colours from the film palette. Each name is
set in SF Pro inside its layer, ink on a light layer and white on a dark one (text-colour-contrast), so the glass, its
layers and its words are one piece that leaves the frame together (film-qa exits tracks each opaque piece: loose small
words beside the glass lose track of themselves as the slide-out speeds up)."""
import os
import sys
from PIL import Image, ImageDraw
from overlay import kit, look
from overlay import stage
from overlay.helpers import paper_pieces as K


def ev_glass_fill(self, e):
    gw, gh = e['w'], e['h']
    n = len(e['layers'])
    W, H = gw + 40, gh + 140
    gx = 20
    gy = 120
    bot_inset = int(gw * 0.14)
    outline = [(gx, gy), (gx + gw, gy), (gx + gw - bot_inset, gy + gh), (gx + bot_inset, gy + gh)]
    fnt = kit.sf('display_semibold', e.get('label_px', 40))
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    lt = [self.T(l['at']) for l in e['layers']]
    t_straw = self.T(e['straw_at']) if e.get('straw_at') is not None else None
    band = (gh - 30) / n
    cache = {}

    def x_at(yy, left=True):  # the glass wall at height yy
        u = (yy - gy) / gh
        return gx + bot_inset * u if left else gx + gw - bot_inset * u

    def picture(tt):
        f_out = min(1.0, max(0.0, (tt - t_in) / 0.6))
        fl = tuple(0.0 if tt < a else round(min(1.0, (tt - a) / 0.35), 2) for a in lt)
        fs = 0.0 if t_straw is None or tt < t_straw else round(min(1.0, (tt - t_straw) / 0.3), 2)
        key = (round(f_out, 2), fl, fs)
        if key in cache:
            return cache[key]
        im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        for k, (l, f) in enumerate(zip(e['layers'], fl)):
            if f <= 0:
                continue
            y1 = gy + gh - 6 - k * band
            y0 = y1 - band * f
            c = stage.rgb(l['colour'])
            d.polygon([(x_at(y0) + 7, y0), (x_at(y0, False) - 7, y0), (x_at(y1, False) - 7, y1), (x_at(y1) + 7, y1)], fill=c + (235,))
            if f >= 1:
                ink = (255, 255, 255) if sum(c) / 3 < 140 else K.INK
                lab = kit.text_img(l['label'], fnt, ink, shadow=False)[0]
                im.alpha_composite(lab, (int(gx + gw / 2 - lab.width / 2), int((y0 + y1) / 2 - lab.height / 2)))
                d = ImageDraw.Draw(im)
        if fs > 0:  # the straw drops in from above, leaning from the right rim, ending in the top layer clear of its name
            sy = gy - 110 + (1 - K.ease_out(fs)) * -200
            d.line([(gx + gw * 0.97, sy), (gx + gw * 0.82, sy + 110 + gh * 0.22)], fill=(255, 255, 255, 255), width=10)
        # the glass, drawn on as one stroke: down the left wall, across the base, up the right wall, then the rim
        path = [outline[0], outline[3], outline[2], outline[1], outline[0]]
        segs = list(zip(path[:-1], path[1:]))
        lens = [((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5 for a, b in segs]
        left = sum(lens) * f_out
        for (a, b), L in zip(segs, lens):
            if left <= 0:
                break
            u = min(1.0, left / L)
            d.line([a, (a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u)], fill=(255, 255, 255, 255), width=8, joint='curve')
            left -= L
        out = stage.shadowed(im, look.LOOK['text_shadow'])[0]
        cache[key] = out
        return out
    x, y = e['pos']
    K.moving(self, e.get('id', 'glass'), picture, x, y, t_in, t_out, enter='none', exit=e.get('exit', 'left'), order=60, drift=False, smooth=True)
    self.sound('marker_long', t_in)
    for k, a in enumerate(lt):
        self.sound(['pop', 'pop2', 'pop3'][k % 3], a)
    if t_straw is not None:
        self.sound('click1', t_straw + 0.28)
    self.sound('slide_out', t_out)
