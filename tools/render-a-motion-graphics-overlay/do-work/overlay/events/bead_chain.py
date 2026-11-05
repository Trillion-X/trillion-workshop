"""bead_chain (lane ch3): a molecule shown as what it is made of: a chain of beads, one bead per unit, threaded on one after
another along a gentle wave as he says "chain", each bead with its own small click; then a white label says what the chain
is (technique: bead-chain build, the standard textbook picture of a peptide as amino-acid beads; filmcraft/options-ch3/TECHNIQUES.md
#bead-chain-build).

    {"type": "bead_chain", "id": "glp1", "start": [x, y], "length": 560, "beads": 30, "at": s, "every_s": 0.035,
     "amp": 26, "waves": 1.5, "label": "GLP-1: a chain of 30 or 31 amino acids", "label_at": s, "label_pos": [x, y],
     "out": s, "exit": "left"}

Beads in the film palette (cream, kraft, white) with an ink rim; white SF Pro label with the soft wide shadow over the
dark backsplash. Drawn at every frame's exact time (lines over footage are not stepped)."""
import math
import os
import sys
import numpy as np
from PIL import Image, ImageDraw
from overlay import kit, look
from overlay import stage
from overlay.helpers import paper_pieces as K

FILLS = ['paper_cream', 'kraft', 'paper_white', 'kraft', 'paper_cream']


def _bead(r, colour):
    S = 4
    im = Image.new('RGBA', (2 * r * S + 4, 2 * r * S + 4), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = stage.rgb(colour)
    d.ellipse([2, 2, 2 + 2 * r * S, 2 + 2 * r * S], fill=c + (255,), outline=K.INK + (255,), width=S * 2)
    hl = [int(min(255, v + 40)) for v in c]
    d.ellipse([2 + r * S * 0.45, 2 + r * S * 0.35, 2 + r * S * 0.95, 2 + r * S * 0.8], fill=tuple(hl) + (200,))
    return im.resize((2 * r + 1, 2 * r + 1), Image.LANCZOS)


def ev_bead_chain(self, e):
    n, L = e['beads'], e['length']
    r = e.get('bead_r', 12)
    amp, waves = e.get('amp', 26), e.get('waves', 1.5)
    x0, y0 = e['start']
    pts = [(x0 + L * k / (n - 1), y0 + amp * math.sin(2 * math.pi * waves * k / (n - 1))) for k in range(n)]
    beads = [_bead(r, FILLS[k % len(FILLS)]) for k in range(n)]
    t0, every, t_out = self.T(e['at']), e.get('every_s', 0.035), self.T(e['out'])
    times = [t0 + k * every for k in range(n)]
    lab = kit.text_img(e['label'], kit.sf('display_semibold', e.get('label_px', 44)), (255, 255, 255), shadow=False)[0]
    t_lab = self.T(e['label_at'])
    pad = 30
    bx0 = int(min(min(p[0] for p in pts), e['label_pos'][0])) - pad
    by0 = int(min(min(p[1] for p in pts) - r, e['label_pos'][1])) - pad
    bx1 = int(max(max(p[0] for p in pts) + r, e['label_pos'][0] + lab.width)) + pad
    by1 = int(max(max(p[1] for p in pts) + r, e['label_pos'][1] + lab.height)) + pad
    cache = {}

    def picture(tt):
        k = int(np.searchsorted(times, tt, side='right'))
        show_lab = tt >= t_lab
        key = (k, show_lab)
        if key in cache:
            return cache[key]
        im = Image.new('RGBA', (bx1 - bx0, by1 - by0), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        if k > 1:  # the thread through the beads placed so far
            d.line([(p[0] - bx0, p[1] - by0) for p in pts[:k]], fill=(255, 255, 255, 255), width=4, joint='curve')
        for j in range(k):
            im.alpha_composite(beads[j], (int(pts[j][0] - bx0 - r), int(pts[j][1] - by0 - r)))
        if show_lab:
            im.alpha_composite(lab, (int(e['label_pos'][0] - bx0), int(e['label_pos'][1] - by0)))
        out, sp = stage.shadowed(im, look.LOOK['text_shadow'])
        cache[key] = (out, sp)
        return out, sp
    pad_s = picture(t_out - 0.01)[1]
    K.moving(self, e.get('id', 'chain'), lambda tt: picture(tt)[0], bx0 - pad_s, by0 - pad_s, t0, t_out, enter='none',
             exit=e.get('exit', 'left'), order=60, drift=False, smooth=True)
    kind = 'beads-' + e.get('id', 'chain')
    self.extra_sounds[kind] = [{'file': self.clicks_sound(kind, t0, times, e.get('click_db', -12)), 'gain_db': 0}]
    self.sound(kind, t0)
    self.sound('word_in', t_lab)
    self.sound('slide_out', t_out)
