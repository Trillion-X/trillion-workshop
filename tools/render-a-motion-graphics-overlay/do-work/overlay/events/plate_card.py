"""plate_card (lane ch3): a real archival plate (an old engraving or textbook figure, public domain) mounted on a cream card
with its credit line underneath, slid in beside him on the word it shows; a red marker ring is drawn round the part he
names, on his word (technique: archival plate card; filmcraft/options-ch3/TECHNIQUES.md#archival-plate-card).

    {"type": "plate_card", "id": "jaw", "image": path, "crop": [x0, y0, x1, y1], "w": 420, "pos": [x, y], "rot": -2,
     "credit": "Gray's Anatomy, 1918", "at": s, "out": s,
     "ring": {"centre": [x, y], "r": [rx, ry], "at": s}}     ring centre and radii in the cropped image's pixels

Ink credit on cream paper; the plate keeps its own printed labels (the engraver's words, not ours)."""
import math
import os
import sys
from PIL import Image, ImageDraw
from overlay.helpers import paper_pieces as K


def _ring(w, h, cx, cy, rx, ry, frac, width):
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    n = 90
    pts = [(cx + rx * math.cos(-math.pi / 2 + 2.15 * math.pi * k / n), cy + ry * math.sin(-math.pi / 2 + 2.15 * math.pi * k / n) * (1 + 0.04 * k / n))
           for k in range(int(n * frac) + 1)]
    if len(pts) > 1:
        ImageDraw.Draw(im).line(pts, fill=K.RED + (255,), width=width, joint='curve')
    return im


def ev_plate_card(self, e):
    plate = K.image_piece(e['image'], e['w'], e.get('crop')).convert('RGB')
    sc = e['w'] / ((e['crop'][2] - e['crop'][0]) if e.get('crop') else Image.open(e['image']).width)
    pad, cap = 22, 56
    self.seed += 1
    card = K.paper(plate.width + 2 * pad, plate.height + pad + cap, 'cream', self.seed, edge='straight')
    card.paste(plate, (pad, pad))
    credit = K.hand(e['credit'], e.get('credit_face', 'SpecialElite-Regular.ttf'), e.get('credit_px', 24))
    card.alpha_composite(credit, ((card.width - credit.width) // 2, plate.height + pad + (cap - credit.height) // 2))
    ring = e.get('ring')
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    t_ring = self.T(ring['at']) if ring else None
    cache = {}

    def picture(tt):
        f = 0.0 if t_ring is None or tt < t_ring else min(1.0, (tt - t_ring) / 0.45)
        key = round(f, 2)
        if key not in cache:
            im = card.copy()
            if f > 0:
                cx, cy = ring['centre']
                rx, ry = ring['r']
                im.alpha_composite(_ring(im.width, im.height, pad + cx * sc, pad + cy * sc, rx * sc, ry * sc, f, 6))
            cache[key] = K.shadow(im.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC))[0]
        return cache[key]
    x, y = e['pos']
    K.moving(self, e.get('id', 'plate'), picture, x, y, t_in, t_out, enter=e.get('enter', 'left'), exit=e.get('exit', 'left'),
             order=e.get('order', 60))
    self.sound('slide_in', t_in)
    if t_ring is not None:
        self.sound('marker', t_ring)
    self.sound('slide_out', t_out)
