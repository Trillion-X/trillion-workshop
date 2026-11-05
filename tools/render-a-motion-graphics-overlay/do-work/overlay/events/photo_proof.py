"""photo_proof (lane ch5): the real thing as proof. A real photograph (a product's own photo, a page) comes in as a printed card
with a white border and its source on the border, settles still, and a marker draws rings round what the words point at, one
ring on each cue (technique: photo-proof-rings, after the Vox / Johnny Harris habit of showing the real document and marking it
by hand; library/techniques/photo-proof-rings.md). The rings are real marker strokes (uneven nib, ink building where the
stroke overlaps its start: _ch5_kit.marker_stroke), drawn round the ring in 0.35 s.

    {"type": "photo_proof", "id": "label", "image": ".../photo.png", "crop": [x0, y0, x1, y1], "pos": [x, y], "w": 540,
     "at": s, "out": s, "enter": "right", "exit": "right", "source": "heydally.com", "colour": [r, g, b],
     "rings": [{"c": [x, y], "r": [rx, ry], "at": s}, ...]}

Ring centres and radii are in the photo's own pixels (after the crop). Sounds: card_in, one ring sound per ring, card_out."""
import math
import os
import sys

from PIL import Image, ImageDraw
from overlay import kit
from overlay import stage

from overlay.helpers import paper_pieces as K
from overlay.helpers import slide_pieces as C

BORDER = 14
FOOT = 46


def ev_photo_proof(self, e):
    sid = e.get('id', 'proof')
    T = self.T
    src = Image.open(e['image']).convert('RGBA')
    if e.get('crop'):
        src = src.crop(tuple(e['crop']))
    W = e.get('w', 540)
    s = (W - 2 * BORDER) / src.width
    ph = src.resize((W - 2 * BORDER, int(round(src.height * s))), Image.LANCZOS)
    H = ph.height + BORDER + FOOT
    base = Image.new('RGBA', (W, H), (250, 249, 245, 255))
    base.alpha_composite(ph, (BORDER, BORDER))
    if e.get('source'):
        d = ImageDraw.Draw(base)
        d.text((BORDER + 2, ph.height + BORDER + FOOT / 2), e['source'], font=kit.sf('text_semibold', e.get('source_px', 26)),
               fill=(70, 70, 66, 255), anchor='lm')
    colour = tuple(e.get('colour', (34, 74, 214)))
    rings = []
    for k, r in enumerate(e.get('rings', [])):
        cx, cy = BORDER + r['c'][0] * s, BORDER + r['c'][1] * s
        rx, ry = r['r'][0] * s, r['r'][1] * s
        a0 = -2.2 + 0.4 * k
        pts = [(cx + rx * math.cos(a0 + 2 * math.pi * 1.08 * i / 60) * (1 + 0.03 * math.sin(i / 7)),
                cy + ry * math.sin(a0 + 2 * math.pi * 1.08 * i / 60)) for i in range(61)]  # a hand's ring: a little past closed
        rings.append((T(r['at']), pts, k))
    cache = {}

    def picture(tt):
        state = tuple(round(min(1.0, max(0.0, (tt - t0) / 0.35)), 2) for t0, _, _ in rings)
        if state in cache:
            return cache[state]
        im = base.copy()
        d = ImageDraw.Draw(im)
        for (t0, pts, k), u in zip(rings, state):
            if u > 0:
                C.marker_stroke(d, C.partial(pts, u), colour, e.get('ring_w', 9), seed=11 + k)
        out = stage.shadowed(im, {'dx': 0, 'dy': 8, 'blur': 14, 'opacity': 0.42})[0]
        if len(cache) > 12:
            cache.pop(next(iter(cache)))
        cache[state] = out
        return out

    x, y = e['pos']
    t_in, t_out = T(e['at']), T(e['out'])
    C.slide(self, sid, picture, x, y, t_in, t_out, enter=e.get('enter', 'right'), exit=e.get('exit', 'right'), order=60)
    self.sound('card_in', t_in)
    for t0, _, _ in rings:
        self.sound('ring', t0)
    self.sound('card_out', t_out)
