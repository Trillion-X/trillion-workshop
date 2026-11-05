"""energy_budget (lane ch5): a day's sum drawn as lengths on graph paper, on the words that say it: blocks of what he eats
stack along a bar, one block per portion, each landing on its word with its value; then the bar of what his body burns
by just existing draws out past them, and the gap between the two ends is bracketed and named (technique: energy budget
bars, the Vox/Johnny Harris "show the sum as lengths" move; library/techniques/energy-budget-bars.md). Every length is
to scale against the same axis, and every value is one he says or the sum of two he says.

    {"type": "energy_budget", "id": "budget", "pos": [x, y], "size": [w, h], "scale_max": 1600,
     "at": s, "out": s, "title": "...",
     "rows": [{"label": "protein", "unit": "g", "scale_max": 130, "blocks": [{"value": 56, "at": s}, ...], "total": {"text": "112 g", "at": s}}],
     "eaten": {"label": "...", "blocks": [{"value": 488, "text": "488", "at": s}, ...], "total": {"text": "976", "at": s}},
     "burn": {"label": "...", "value": 1500, "at": s, "dur": s, "value_text": "about 1,500", "value_at": s},
     "gap": {"text": "deficit", "at": s}}

Ink on graph paper; kraft blocks for what he eats, a dashed outline for what he burns (fact and estimate never look the
same); hand-lettered labels (Kalam, fun-faces-on-paper). A paper piece sound per block, the marker for drawn lines."""
import os
import sys
from PIL import Image, ImageDraw
from overlay import kit
from overlay import look, stage
from overlay.helpers import paper_pieces as K


def _dashed(d, p0, p1, fill, w, dash=16, gap=10):
    L = ((p1[0] - p0[0]) ** 2 + (p1[1] - p0[1]) ** 2) ** 0.5
    s = 0.0
    while s < L:
        a, b = s / L, min(L, s + dash) / L
        d.line([(p0[0] + (p1[0] - p0[0]) * a, p0[1] + (p1[1] - p0[1]) * a), (p0[0] + (p1[0] - p0[0]) * b, p0[1] + (p1[1] - p0[1]) * b)], fill=fill, width=w)
        s += dash + gap


def ev_energy_budget(self, e):
    sid = e.get('id', 'budget')
    W, H = e['size']
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    card = Image.new('RGBA', (W, H), (247, 247, 241, 255))
    d = ImageDraw.Draw(card)
    for k in range(0, max(W, H), 24):
        d.line([(k, 0), (k, H)], fill=kit.col('grid') + (110,), width=1)
        d.line([(0, k), (W, k)], fill=kit.col('grid') + (110,), width=1)
    card = stage.apply_texture(card, 'sheet', 31, 0.3)
    m = Image.new('L', (W, H), 0)
    ImageDraw.Draw(m).polygon(stage.torn_polygon(W, H, 5, 37, step=9), fill=255)
    card.putalpha(m)
    ink = K.INK + (255,)
    kraft = stage.rgb('kraft') + (255,)
    ft = K.face('Kalam-Bold.ttf', e.get('title_px', 38))
    fl = K.face('Kalam-Bold.ttf', e.get('label_px', 30))
    fv = K.face('CourierPrime-Bold.ttf', e.get('value_px', 28))
    fw = K.face('PermanentMarker-Regular.ttf', e.get('word_px', 34))
    if e.get('title'):
        ImageDraw.Draw(card).text((W / 2, 22), e['title'], font=ft, fill=ink, anchor='mt')
    x0, x1 = 40, W - 40
    scale = (x1 - x0) / e['scale_max']
    T = self.T
    eaten, burn, gap = e['eaten'], e.get('burn'), e.get('gap')
    rows = e.get('rows', [])
    y_eat = e.get('eaten_y', 150)
    bh = 64
    y_burn = y_eat + bh + 70
    y_rows = [y_burn + bh + 130 + i * (bh + 70) for i in range(len(rows))]
    eb = [dict(b, at=T(b['at'])) for b in eaten['blocks']]
    rb = [[dict(b, at=T(b['at'])) for b in r['blocks']] for r in rows]
    tot_at = T(eaten['total']['at']) if eaten.get('total') else None
    rtot = [T(r['total']['at']) if r.get('total') else None for r in rows]
    b_at = T(burn['at']) if burn else None
    bv_at = T(burn['value_at']) if burn and burn.get('value_at') else None
    g_at = T(gap['at']) if gap else None
    cache = {}

    def grow(tt, a, s=0.35):
        return 0.0 if a is None or tt < a else min(1.0, (tt - a) / s)

    def blocks(dd, y, items, sc, tt):
        x = x0
        for b in items:
            u = grow(tt, b['at'], 0.3)
            w = b['value'] * sc
            if u > 0:
                yy = y - (1 - K.ease_out(u)) * 40  # the block drops into its place
                dd.rectangle([x + 2, yy, x + w - 2, yy + bh], fill=kraft, outline=ink, width=3)
                if u >= 1:
                    dd.text((x + w / 2, yy + bh / 2), b.get('text', str(b['value'])), font=fv, fill=ink, anchor='mm')
            x += w
        return x

    def picture(tt):
        key = (round(min(max(tt, t_in), t_out) * 12),)
        if key in cache:
            return cache[key]
        im = card.copy()
        dd = ImageDraw.Draw(im)
        dd.text((x0, y_eat - 12), eaten['label'], font=fl, fill=ink, anchor='lb')
        end = blocks(dd, y_eat, eb, scale, tt)
        if grow(tt, tot_at) >= 1:
            dd.text((end + 14, y_eat + bh / 2), eaten['total']['text'], font=fw, fill=ink, anchor='lm')
        if burn and grow(tt, b_at) > 0:
            u = K.ease_out(grow(tt, b_at, burn.get('dur', 1.2)))
            bx = x0 + burn['value'] * scale * u
            dd.text((x0, y_burn - 12), burn['label'], font=fl, fill=ink, anchor='lb')
            for (p, q) in (((x0, y_burn), (bx, y_burn)), ((x0, y_burn + bh), (bx, y_burn + bh)), ((x0, y_burn), (x0, y_burn + bh))):
                _dashed(dd, p, q, ink, 4)
            if u >= 1:
                _dashed(dd, (bx, y_burn), (bx, y_burn + bh), ink, 4)
                if grow(tt, bv_at) >= 1:
                    dd.text((bx - 12, y_burn + bh / 2), burn['value_text'], font=fv, fill=ink, anchor='rm')
        if gap and grow(tt, g_at) > 0:  # bracket from the end of what he eats to the end of what he burns
            ge = x0 + burn['value'] * scale
            ys = y_burn + bh + 10  # under the burned bar, from where the eaten blocks end to where the burn ends
            gx = end + (ge - end) * K.ease_out(grow(tt, g_at, 0.5))
            dd.line([(end, ys), (end, ys + 16), (gx, ys + 16)], fill=ink, width=4)
            if gx >= ge - 1:
                dd.line([(ge, ys + 16), (ge, ys)], fill=ink, width=4)
                dd.text(((end + ge) / 2, ys + 22), gap['text'], font=fw, fill=ink, anchor='mt')
        for r, y, items, ta in zip(rows, y_rows, rb, rtot):
            if grow(tt, items[0]['at']) > 0:
                dd.text((x0, y - 12), r['label'], font=fl, fill=ink, anchor='lb')
            rend = blocks(dd, y, items, (x1 - x0) / r['scale_max'], tt)
            if grow(tt, ta) >= 1:
                dd.text((rend + 14, y + bh / 2), r['total']['text'], font=fw, fill=ink, anchor='lm')
        out = stage.shadowed(im.rotate(-e.get('rot', -1.0), expand=True, resample=Image.BICUBIC), look.R['card']['shadow'])[0]
        if len(cache) > 6:
            cache.pop(next(iter(cache)))
        cache[key] = out
        return out
    x, y = e['pos']
    K.moving(self, sid, picture, x, y, t_in, t_out, enter='right', exit=e.get('exit', 'right'), order=58, drift=False, smooth=False)
    self.sound('slide_in', t_in)
    for k, b in enumerate(eb + [b for r in rb for b in r]):
        self.sound(['piece1', 'piece2', 'piece3'][k % 3], b['at'])
    if b_at is not None:
        self.sound('marker_long', b_at)
    if g_at is not None:
        self.sound('marker_long', g_at)
    self.sound('slide_out', t_out)
