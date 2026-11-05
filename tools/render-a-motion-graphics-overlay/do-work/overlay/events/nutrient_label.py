"""nutrient_label (lane ch5): what "deficient in many things" means, as the reference everyone has seen: a panel in the look
of the US Nutrition Facts label (black on white, heavy title, thick and thin black rules, bold nutrient names, values right)
listing the nutrients the FDA tells people to get more of, with their Daily Values; an empty box per row, ticked by hand in
green one by one as he says what he wants to put in (technique: nutrient-label checklist, after the FDA label's own layout and
a Vox-style "show the real reference"; library/techniques/nutrient-label-checklist.md).

    {"type": "nutrient_label", "id": "dv", "pos": [x, y], "w": 470, "at": s, "out": s, "enter": "top", "exit": "top",
     "title": "Daily Values", "sub": "Get more of these", "rows": [["Dietary fiber", "28 g"], ...],
     "ticks": [s, ...], "source": "Source: FDA"}

The label is a document: it slides in whole (motion blur on the slide) and sits perfectly still; only the ticks change it.
Sounds: paper swipe in, one short felt-pen stroke per tick (a different part of the recording each time, check1..check5), a
swish out."""
import os
import sys

from PIL import Image, ImageDraw

from overlay import kit
from overlay.helpers import paper_pieces as K
from overlay.helpers import slide_pieces as C

BLACK = (12, 12, 12)
GREEN = (24, 138, 72)


def ev_nutrient_label(self, e):
    sid = e.get('id', 'label')
    T = self.T
    W = e.get('w', 470)
    pad = 18
    ft = kit.sf('display_heavy', e.get('title_px', 56))
    fs = kit.sf('text_semibold', e.get('sub_px', 28))
    fr = kit.sf('display_bold', e.get('row_px', 32))
    fv = kit.sf('text_medium', e.get('row_px', 32))
    fsrc = kit.sf('text_medium', e.get('source_px', 24))
    row_h = int(e.get('row_px', 32) * 1.75)
    box = int(e.get('row_px', 32) * 0.9)
    y_rows = pad + 70 + 14 + 44 + 6
    H = y_rows + row_h * len(e['rows']) + 8 + 44
    base = Image.new('RGBA', (W, H), (255, 255, 255, 255))
    d = ImageDraw.Draw(base)
    d.rectangle([0, 0, W - 1, H - 1], outline=BLACK + (255,), width=3)
    d.text((pad, pad - 6), e['title'], font=ft, fill=BLACK + (255,))
    d.rectangle([pad, pad + 70, W - pad, pad + 70 + 12], fill=BLACK + (255,))
    d.text((pad, pad + 70 + 18), e['sub'], font=fs, fill=BLACK + (255,))
    d.rectangle([pad, y_rows - 4, W - pad, y_rows], fill=BLACK + (255,))
    boxes = []
    for k, (name, value) in enumerate(e['rows']):
        y = y_rows + k * row_h
        cy = y + row_h / 2
        bx = (pad, cy - box / 2, pad + box, cy + box / 2)
        d.rectangle(bx, outline=BLACK + (255,), width=3)
        boxes.append(bx)
        d.text((pad + box + 16, cy), name, font=fr, fill=BLACK + (255,), anchor='lm')
        d.text((W - pad, cy), value, font=fv, fill=BLACK + (255,), anchor='rm')
        d.line([(pad, y + row_h), (W - pad, y + row_h)], fill=BLACK + (255,), width=1)
    d.rectangle([pad, y_rows + row_h * len(e['rows']), W - pad, y_rows + row_h * len(e['rows']) + 6], fill=BLACK + (255,))
    d.text((pad, H - 40), e['source'], font=fsrc, fill=(60, 60, 60, 255))
    ticks = [T(t) for t in e['ticks']]
    t_in, t_out = T(e['at']), T(e['out'])
    cache = {}

    def picture(tt):
        us = tuple(round(min(1.0, max(0.0, (tt - t0) / 0.22)), 2) for t0 in ticks)
        if us in cache:
            return cache[us]
        im = base.copy()
        dd = ImageDraw.Draw(im)
        for (x0, y0, x1, y1), u in zip(boxes, us):
            if u > 0:  # a check: short stroke down into the box, long stroke up past its corner
                pts = [(x0 + 5, (y0 + y1) / 2), (x0 + box * 0.42, y1 - 4), (x1 + box * 0.35, y0 - box * 0.45)]
                C.marker_stroke(dd, C.partial(pts, u), GREEN, 8, seed=int(y0))
        out = K.shadow(im)[0]
        if len(cache) > 12:
            cache.pop(next(iter(cache)))
        cache[us] = out
        return out

    x, y = e['pos']
    C.slide(self, sid, picture, x, y, t_in, t_out, enter=e.get('enter', 'top'), exit=e.get('exit', 'top'), order=60)
    self.sound('card_in', t_in)
    for k, t in enumerate(ticks):
        self.sound(f'check{k % 5 + 1}', t)
    self.sound('card_out', t_out)
