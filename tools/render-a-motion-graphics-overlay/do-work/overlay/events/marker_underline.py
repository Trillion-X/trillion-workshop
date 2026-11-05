"""marker_underline (lane ch1, round 8): one hand-drawn red marker underline drawn on left to right while the narrator says the words it
stresses (device DV207 "hand-drawn marker layer", itsnotmybusiness/0Rqoe5quCJQ, library/devices/creator-deconstruction-2026-10-23.md
lines 235 and 265: the base term lands first, a pause of about 0.63 s, then the underline is drawn, then the completed line holds
until the return; drawing, pause, emphasis and hold are separate times). Original art: a wobbling polyline, not a copy of theirs.

    {"type": "marker_underline", "id": "u", "pos": [x, y], "w": px, "at": s, "write_s": 0.5, "seed": 3}

pos is the left end of the line; it is on top of the page with no card behind it (ink on a light backing: text-colour-contrast)."""
import os
import sys
import numpy as np
from PIL import Image, ImageDraw
from overlay import look, stage
from overlay.helpers import paper_pieces as K


def ev_marker_underline(self, e):
    sid = e.get('id', 'underline')
    w, thick = int(e['w']), e.get('thick', 7)
    rng = np.random.default_rng(e.get('seed', 3))
    pad = 10
    im = Image.new('RGBA', (w + 2 * pad, 26 + 2 * pad), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    pts = [(pad + i * 6, pad + 13 + 3.2 * np.sin(i * 0.37 + e.get('seed', 3)) + rng.normal(0, 0.8) + (i * 6 / w) * -4) for i in range(w // 6 + 1)]
    d.line(pts, fill=K.RED + (255,), width=thick, joint='curve')
    for cx, cy in (pts[0], pts[-1]):  # round the ends like a felt tip
        d.ellipse([cx - thick / 2, cy - thick / 2, cx + thick / 2, cy + thick / 2], fill=K.RED + (255,))
    t0, write_s = self.T(e['at']), e.get('write_s', 0.5)
    cache = {}

    def dyn(tt):
        if tt < t0:
            return None, 0, 0
        f = round(min(1.0, (tt - t0) / write_s), 2)
        if f not in cache:
            cache[f] = K.reveal(im, f)
        return cache[f], e['pos'][0] - pad, e['pos'][1] - pad
    self.safe_box(sid, *self.opaque_box(im, e['pos'][0] - pad, e['pos'][1] - pad), t0)
    sp = stage.Sprite(sid, None, 0, 0, t0, 'none', 0, order=e.get('order', 74), jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    # the whiteboard marker kind measured scratchy (film-qa sound-harsh: 85 percent of its energy above 4 kHz) and under his voice by 19 dB;
    # the ch3 lane's designed felt-tip stroke is the soft sound for the same action (its files are in options-ch3/assets/sfx/designed)
    felt = look.asset(look.section('marker_underline')['felt_stroke'])
    self.extra_sounds['underline_felt'] = [{'file': felt, 'gain_db': e.get('felt_gain_db', -3)}]
    self.sound('underline_felt', t0)
