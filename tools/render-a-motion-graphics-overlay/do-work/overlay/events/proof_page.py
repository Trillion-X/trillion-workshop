"""proof_page (lane ch5): the real source page as the proof of what he says, marked with a real highlighter on its own words
(technique: proof page highlight; library/techniques/proof-page-highlight.md). A screenshot of the live page (not retyped
text) sits in a plain browser frame carrying the site's real address, slides in with motion blur, sits still while it is
read, and on his words a highlighter stroke runs along each named phrase, left to right, line by line: a chisel nib whose
ink is transparent (multiplied over the type, so the letters stay black), builds up darker where the pen rests at the start
and end of a stroke, and wavers a little along its length, as Vox and Johnny Harris mark the documents they cite.

    {"type": "proof_page", "id": "fda", "image": page.png, "crop": [x0, y0, x1, y1],
     "w": 760, "pos": [x, y], "at": s, "out": s, "enter": "right", "exit": "right", "rot": -1.0,
     "bar": "fda.gov", "source": "U.S. Food and Drug Administration",
     "marks": [{"phrase": "...", "colour": "yellow" | "green", "at": s, "line_s": 0.36, "sound": kind}, ...]}

<image stem>.words.json beside the image maps each phrase to its line rectangles in the screenshot's pixels (measured on the page when it was taken,
options-ch5/tools/r2/m03_tools/fda_shot.py), so a mark always lies on the words it names. Each line of a mark plays its
`sound` (one per line, so a two-line mark sounds twice, like two strokes). Sounds: card_in, the strokes, card_out."""
import json
import math
import os
import random
import sys

import numpy as np
from PIL import Image, ImageDraw
from overlay import kit, look
from overlay import stage

from overlay.helpers import paper_pieces as K
from overlay.helpers import slide_pieces as C

INK = {'yellow': (255, 224, 60), 'green': (150, 232, 112), 'pink': (255, 150, 190)}
BAR_H = 44


def nib_mask(size, x0, y0, x1, y1, frac, seed):
    """Highlighter coverage (0..1 float array of `size`) for one stroke along [x0, x1] at the band y0..y1, drawn to `frac`."""
    w, h = size
    a = np.zeros((h, w), np.float32)
    if frac <= 0:
        return a
    rnd = random.Random(seed)
    bh = (y1 - y0) * 1.1
    cy = (y0 + y1) / 2 + 1.5
    nib = max(6.0, bh * 0.34)
    end = x0 - 4 + (x1 - x0 + 8) * frac
    yy, xx = np.mgrid[0:h, 0:w]
    x = x0 - 4.0
    wob = rnd.uniform(0, math.tau)
    while x <= end:
        yc = cy + 1.4 * math.sin(wob + x / 37.0)
        hh = bh * (0.96 + 0.05 * math.sin(wob * 2 + x / 23.0))
        rest = 1.0 + 1.6 * math.exp(-((x - x0 + 4) / 9.0) ** 2) + (1.4 * math.exp(-((x - end) / 9.0) ** 2) if frac >= 1 else 0)
        dab = ((np.abs(xx - x) <= nib / 2) & (np.abs(yy - yc) <= hh / 2)).astype(np.float32) * 0.13 * rest
        a = 1 - (1 - a) * (1 - np.minimum(dab, 0.6))
        x += 2.0
    return a


def ev_proof_page(self, e):
    sid = e.get('id', 'proof')
    T = self.T
    page = Image.open(e['image']).convert('RGB')
    cx0, cy0, cx1, cy1 = e.get('crop', [0, 0, page.width, page.height])
    page = page.crop((cx0, cy0, cx1, cy1))
    W = e.get('w', 760)
    s = W / page.width
    page = page.resize((W, int(page.height * s)), Image.LANCZOS)
    boxes = json.load(open(os.path.splitext(e['image'])[0] + '.words.json'))
    fbar = kit.sf('text_semibold', e.get('bar_px', 24))
    fsrc = kit.sf('text_semibold', e.get('source_px', 26))
    PH = page.height
    H = BAR_H + PH
    strokes = []  # (t0, t1, colour, x0, y0, x1, y1, seed) in page pixels
    for k, m in enumerate(e['marks']):
        t = T(m['at'])
        ls = m.get('line_s', 0.36)
        for j, (rx0, ry0, rx1, ry1) in enumerate(boxes[m['phrase']]):
            box = [(rx0 - cx0) * s, (ry0 - cy0) * s, (rx1 - cx0) * s, (ry1 - cy0) * s]
            frac_w = (box[2] - box[0]) / W
            d = ls * max(0.45, frac_w * 1.6)
            strokes.append((t, t + d, INK[m.get('colour', 'yellow')], *box, 17 + 5 * k + j))
            if m.get('sound'):
                self.sound(m['sound'][j % len(m['sound'])] if isinstance(m['sound'], list) else m['sound'], t)
            t += d + 0.05
    np_page = np.asarray(page, np.float32) / 255.0
    t_in, t_out = T(e['at']), T(e['out'])
    src_h = 44 if e.get('source') else 0
    cache = {}

    def picture(tt):
        fr = tuple(round(min(1.0, max(0.0, (tt - a) / (b - a))), 2) for a, b, *_ in strokes)
        if fr in cache:
            return cache[fr]
        img = np_page.copy()
        for f, (_, _, colour, x0, y0, x1, y1, seed) in zip(fr, strokes):
            if f > 0:
                cov = nib_mask((W, PH), x0, y0, x1, y1, f, seed)[..., None]
                img = img * (1 - cov * (1 - np.array(colour, np.float32) / 255.0))
        shot = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
        card = Image.new('RGBA', (W, H), (255, 255, 255, 255))
        d = ImageDraw.Draw(card)
        d.rectangle([0, 0, W, BAR_H], fill=(236, 236, 238, 255))
        for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
            d.ellipse([16 + 22 * i, BAR_H / 2 - 6, 28 + 22 * i, BAR_H / 2 + 6], fill=c + (255,))
        d.rounded_rectangle([96, 8, W - 96, BAR_H - 8], radius=8, fill=(255, 255, 255, 255))
        d.text((W / 2, BAR_H / 2), e['bar'], font=fbar, fill=(60, 60, 64, 255), anchor='mm')
        card.paste(shot, (0, BAR_H))
        m = Image.new('L', (W, H), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, W - 1, H - 1], radius=14, fill=255)
        card.putalpha(m)
        pic, pad = K.shadow(card.rotate(e.get('rot', -1.0), expand=True, resample=Image.BICUBIC))
        if e.get('source'):  # the credit under the page, white with the film's soft text shadow, over the footage
            lay = Image.new('RGBA', (W, src_h), (0, 0, 0, 0))
            ImageDraw.Draw(lay).text((4, 8), e['source'], font=fsrc, fill=(255, 255, 255, 255))
            ts, tpad = stage.shadowed(lay, look.LOOK['text_shadow'])
            ty = pic.height - pad + 10 - tpad  # just under the page's lower edge
            full = Image.new('RGBA', (max(pic.width, pad + ts.width), ty + ts.height), (0, 0, 0, 0))
            full.alpha_composite(pic)
            full.alpha_composite(ts, (max(0, pad - tpad), ty))
            pic = full
        if len(cache) > 16:
            cache.pop(next(iter(cache)))
        cache[fr] = pic
        return pic

    x, y = e['pos']
    C.slide(self, sid, picture, x, y, t_in, t_out, enter=e.get('enter', 'right'), exit=e.get('exit', 'right'), order=60)
    self.sound('card_in', t_in)
    self.sound('card_out', t_out)
