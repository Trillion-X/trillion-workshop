"""ruler_bracket (lane ch3): a paper measuring ruler of one quantity; on his words a marker bracket is drawn over a span of
it with its label, so two amounts are compared on one scale (technique: measuring ruler with brackets, a physical take on
Annotation callout #240; filmcraft/options-ch3/TECHNIQUES.md#measuring-ruler-bracket).

    {"type": "ruler_bracket", "id": "ruler", "pos": [x, y], "w": 760, "max": 20, "major": 5, "unit": "g",
     "title": "creatine, grams a day", "at": s, "out": s,
     "brackets": [{"from": 10, "to": 20, "label": "10-20 g", "colour": "red", "side": "above", "at": s}, ...]}

Ink ticks and numbers on kraft paper; brackets in the accent red or ink, drawn left to right in 0.4 s with the marker."""
import os
import sys
from PIL import Image, ImageDraw
from overlay.helpers import paper_pieces as K


def ev_ruler_bracket(self, e):
    W, top_room, ruler_h = e['w'], 120, 110
    self.seed += 1
    ruler = K.paper(W, ruler_h, 'kraft', self.seed, edge='straight')
    d = ImageDraw.Draw(ruler)
    lo, hi = 40, W - 40
    fnum = K.face('CourierPrime-Bold.ttf', 24)
    vmax, major = e['max'], e.get('major', 5)
    X = lambda v: lo + (hi - lo) * v / vmax  # noqa: E731
    for v in range(vmax + 1):
        L = 42 if v % major == 0 else 24
        d.line([(X(v), 0), (X(v), L)], fill=K.INK + (255,), width=3 if v % major == 0 else 2)
        if v % major == 0:
            d.text((X(v), L + 4), f'{v}', font=fnum, fill=K.INK + (255,), anchor='ma')
    title = K.hand(e['title'], 'SpecialElite-Regular.ttf', 22)
    ruler.alpha_composite(title, (W - title.width - 14, ruler_h - title.height - 6))
    rs, sp = K.shadow(ruler, soft=True)
    base = Image.new('RGBA', (rs.width, top_room + rs.height + 50), (0, 0, 0, 0))
    base.alpha_composite(rs, (0, top_room - sp))
    X0 = X
    X = lambda v: sp + X0(v)  # noqa: E731  (base coordinates: the ruler sits sp px in from the shadow's edge)
    brackets = []
    for b in e['brackets']:
        colour = K.RED if b.get('colour', 'red') == 'red' else K.INK
        x0, x1 = X(b['from']), X(b['to'])
        above = b.get('side', 'above') == 'above'
        y_line = top_room - 18 if above else top_room + ruler_h + 12
        tip = 14 if above else -14
        lab = K.hand(b['label'], b.get('face', 'PermanentMarker-Regular.ttf'), b.get('px', 34), colour)
        ly = y_line - lab.height - 8 if above else y_line + 6
        brackets.append((x0, x1, y_line, tip, colour, lab, ly, self.T(b['at'])))
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    cache = {}

    def picture(tt):
        fr = tuple(0.0 if tt < b[7] else round(min(1.0, (tt - b[7]) / 0.4), 2) for b in brackets)
        if fr in cache:
            return cache[fr]
        im = base.copy()
        dd = ImageDraw.Draw(im)
        for (x0, x1, yl, tip, colour, lab, ly, _), f in zip(brackets, fr):
            if f <= 0:
                continue
            xe = x0 + (x1 - x0) * f
            dd.line([(x0, yl + tip), (x0, yl)], fill=colour + (255,), width=5)
            dd.line([(x0, yl), (xe, yl)], fill=colour + (255,), width=5)
            if f >= 1:
                dd.line([(x1, yl), (x1, yl + tip)], fill=colour + (255,), width=5)
            lx = min(max(0, int((x0 + x1) / 2 - lab.width / 2)), im.width - lab.width)
            im.alpha_composite(K.reveal(lab, max(0.0, f * 1.4 - 0.4)), (lx, int(ly)))
            dd = ImageDraw.Draw(im)
        out = im.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC)
        cache[fr] = out
        return out
    x, y = e['pos']
    K.moving(self, e.get('id', 'ruler'), picture, x, y, t_in, t_out, enter=e.get('enter', 'right'), exit=e.get('exit', 'right'), order=60,
             paper_exits=True)
    self.sound('slide_in', t_in)
    for b in brackets:
        self.sound('marker', b[7])
    K.leave_sound(self, e.get('exit', 'right'), t_out)
