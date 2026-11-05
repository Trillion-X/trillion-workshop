"""fact_grid (lane ch5): a fact check with no narrator. His own words come up on a card in quotation marks; a red marker
line strikes them on his word; a grid of 100 cells fills with what the thing is really made of (91 of 100 cells blue:
water), and the sourced number is written underneath in green (technique: unit-grid fact check, combining Unit Grid Fill
#245 (keep the denominator visible), Strikethrough Replace #110 and a Vox-style source line;
library/techniques/unit-grid-fact-check.md).

    {"type": "fact_grid", "id": "melon", "pos": [x, y], "w": 540, "at": s, "out": s, "enter": "right", "exit": "right",
     "claim": {"text": "“high in calories”", "strike_at": s},
     "grid": {"at": s, "fill_s": 1.0, "filled": 91, "label": "91 g of every 100 g is water"},
     "figure": {"text": "about 30 calories", "sub": "per 100 g", "at": s},
     "source": "Source: USDA FoodData Central"}

A white card that slides in and out smoothly (motion blur on the slide), sitting still while it is up. The red strike is a
real marker line (uneven nib, ink building up), the grid fills row by row, the figure lands with a small ease. Sounds: a
paper swipe in, a marker stroke for the strike, one rising run of bubbles while the water fills (one designed sound that
follows the fill, never a tick per cell), a soft tap for the figure, a swish out at the same level as the swipe in."""
import os
import sys

from PIL import Image, ImageDraw

from overlay.helpers import paper_pieces as K
from overlay.helpers import slide_pieces as C

BLUE = (52, 118, 196)
PALE = (214, 214, 206)
GREEN = (24, 138, 72)


def ev_fact_grid(self, e):
    sid = e.get('id', 'fact')
    T = self.T
    W = e.get('w', 540)
    cell, gap, pad = (W - 2 * 44 - 9 * 6) // 10, 6, 44
    fq = K.face('Kalam-Bold.ttf', e.get('claim_px', 46))
    fl = K.face('Kalam-Bold.ttf', e.get('label_px', 30))
    ff = K.face('PermanentMarker-Regular.ttf', e.get('figure_px', 58))
    fs = K.face('Kalam-Bold.ttf', e.get('sub_px', 34))
    fsrc = K.face('CourierPrime-Bold.ttf', e.get('source_px', 24))
    claim, grid, fig = e['claim'], e['grid'], e['figure']
    y_claim = 40
    y_grid = y_claim + 90
    y_label = y_grid + 10 * cell + 9 * gap + 16
    y_fig = y_label + 62
    y_src = y_fig + 128
    H = y_src + 50
    base = K.paper(W, H, 'white', seed=53, edge='straight')
    d = ImageDraw.Draw(base)
    d.text((W / 2, y_claim), claim['text'], font=fq, fill=K.INK + (255,), anchor='mt')
    if e.get('source'):
        d.text((W / 2, y_src), e['source'], font=fsrc, fill=(96, 96, 92, 255), anchor='mt')
    cb = d.textbbox((W / 2, y_claim), claim['text'], font=fq, anchor='mt')
    strike = [(cb[0] - 10, (cb[1] + cb[3]) / 2 + 6), ((cb[0] + cb[2]) / 2, (cb[1] + cb[3]) / 2 + 1), (cb[2] + 10, (cb[1] + cb[3]) / 2 - 4)]
    t_in, t_out = T(e['at']), T(e['out'])
    t_strike, t_grid, t_fig = T(claim['strike_at']), T(grid['at']), T(fig['at'])
    fill_s, filled = grid.get('fill_s', 1.0), grid.get('filled', 91)
    cache = {}

    def picture(tt):
        su = min(1.0, max(0.0, (tt - t_strike) / 0.32))
        n = int(round(filled * min(1.0, max(0.0, (tt - t_grid) / fill_s)))) if tt >= t_grid else 0
        fu = min(1.0, max(0.0, (tt - t_fig) / 0.3))
        key = (round(su, 2), n, round(fu, 2), tt >= t_grid + fill_s)
        if key in cache:
            return cache[key]
        im = base.copy()
        dd = ImageDraw.Draw(im)
        if su > 0:
            C.marker_stroke(dd, C.partial(strike, su), K.RED, 13, seed=7)
        if tt >= t_grid:
            for k in range(100):
                r, c = divmod(k, 10)
                x0 = pad + c * (cell + gap)
                y0 = y_grid + r * (cell + gap)
                dd.rounded_rectangle([x0, y0, x0 + cell, y0 + cell], radius=5, fill=(BLUE if k < n else PALE) + (255,))
            if key[3]:
                dd.text((W / 2, y_label), grid['label'], font=fl, fill=K.INK + (255,), anchor='mt')
        if fu > 0:
            s = C.ease_out_back(fu)
            lay = Image.new('RGBA', (W, 130), (0, 0, 0, 0))
            ld = ImageDraw.Draw(lay)
            ld.text((W / 2, 0), fig['text'], font=ff, fill=GREEN + (255,), anchor='mt')
            ld.text((W / 2, 72), fig['sub'], font=fs, fill=GREEN + (255,), anchor='mt')
            if abs(s - 1) > 0.001:  # scaled about its centre (the overshoot of the landing)
                lw, lh = max(1, int(W * s)), max(1, int(130 * s))
                small = lay.resize((lw, lh), Image.LANCZOS)
                lay = Image.new('RGBA', (W, 130), (0, 0, 0, 0))
                lay.paste(small, ((W - lw) // 2, (130 - lh) // 2), small)
            lay.putalpha(lay.getchannel('A').point(lambda a: int(a * min(1.0, fu * 2.5))))
            im.alpha_composite(lay, (0, y_fig))
        out = K.shadow(im.rotate(e.get('rot', 1.2), expand=True, resample=Image.BICUBIC))[0]
        if len(cache) > 12:
            cache.pop(next(iter(cache)))
        cache[key] = out
        return out

    x, y = e['pos']
    C.slide(self, sid, picture, x, y, t_in, t_out, enter=e.get('enter', 'right'), exit=e.get('exit', 'right'), order=60)
    self.sound('card_in', t_in)
    self.sound('strike', t_strike)
    self.sound('water_fill', t_grid)
    self.sound('tap', t_fig)
    self.sound('card_out', t_out)
