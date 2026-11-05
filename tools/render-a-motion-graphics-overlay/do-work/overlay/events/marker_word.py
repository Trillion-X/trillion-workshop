"""marker_word (lane ch1 cold opens, round 8): one word written in red marker on the word he says, then a red marker underline drawn under it (device DV207
"hand-drawn marker layer", itsnotmybusiness/0Rqoe5quCJQ, CIS F-0266, library/devices/creator-deconstruction-2026-10-23.md lines 235 and 265: the word is written on, a
pause, then the underline is drawn, then the finished marks hold). Original art: marker face and a wobbling polyline, left to right with the felt-tip's round ends.
No backing: red ink straight on the bright wall (text-colour-contrast: it sits on the light part of the frame, away from his face and hands).

    {"type": "marker_word", "id": "m", "text": "deficient", "pos": [x, y], "size": 120, "at": s, "write_s": 0.5, "underline_at": s, "underline_s": 0.35,
     "out": s, "seed": 3}

pos is the top-left of the word; `at` is the time he starts saying it. The marks clear in one hard cut at `out`."""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from overlay import stage

from overlay.helpers import paper_pieces as K
from overlay.helpers.writing_sounds import write_sound


def ev_marker_word(self, e):
    sid = e.get('id', 'mword')
    size = e.get('size', 120)
    word = K.hand(e['text'], e.get('face', 'PermanentMarker-Regular.ttf'), size, K.RED)
    w = word.width
    thick = e.get('thick', 15)
    rng = np.random.default_rng(e.get('seed', 3))
    pad = 12
    # the DV207 marker stroke: a thick felt-tip underline that swells in the middle and thins at the ends, with ink density varying along it and a darker rim
    under = Image.new('RGBA', (w + 2 * pad, 40 + 2 * pad), (0, 0, 0, 0))
    d = ImageDraw.Draw(under)
    n = w // 5 + 1
    for i in range(n):
        u = i / max(1, n - 1)
        cx = pad + i * 5
        cy = pad + 20 + 3.6 * np.sin(i * 0.31 + e.get('seed', 3)) + rng.normal(0, 0.6) + u * -6
        r = thick * (0.55 + 0.5 * np.sin(np.pi * min(1.0, 0.15 + 0.85 * u))) / 2 * 1.6
        dens = int(215 + 40 * rng.random())
        d.ellipse([cx - r, cy - r * 0.8, cx + r, cy + r * 0.8], fill=K.RED + (dens,))
    gap = int(word.height * 0.9)
    canvas_h = gap + under.height
    x0, y0 = e['pos']
    t_word, t_under, t_out = self.T(e['at']), self.T(e['underline_at']), self.T(e['out'])
    write_s, under_s = e.get('write_s', 0.5), e.get('underline_s', 0.35)
    self.safe_box(sid, x0, y0, x0 + w, y0 + canvas_h, t_word, t_out)
    cache = {}

    def dyn(tt):
        if not (t_word <= tt < t_out):
            return None, 0, 0
        f1 = round(min(1.0, (tt - t_word) / write_s), 2)
        f2 = round(max(0.0, min(1.0, (tt - t_under) / under_s)), 2) if tt >= t_under else -1
        key = (f1, f2)
        if key not in cache:
            im = Image.new('RGBA', (w + 2 * pad, canvas_h + pad), (0, 0, 0, 0))
            im.alpha_composite(K.reveal(word, f1), (pad, 0))
            if f2 >= 0:
                im.alpha_composite(K.reveal(under, f2), (0, gap))
            cache[key] = im
        return cache[key], x0 - pad, y0
    sp = stage.Sprite(sid, None, 0, 0, t_word, 'none', 0, order=e.get('order', 74), jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    write_sound(self, 0, t_word, write_s)   # soft cloth swipes (the 'marker' recording is scratchy: film-qa sound-harsh)
    write_sound(self, 1, t_under, under_s)
