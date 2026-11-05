"""tracked-circle: a hand-drawn red ring drawn round the spot he points at, following that spot as he moves (annotation callout,
awesome-ai-motion #240, with the tracked-redaction rule #356 that the mark and the thing share one motion: the ring is placed
from a per-frame track of the spot, measured on the footage). Drawn on in draw_s with a real marker sound, held, then it
fades out where it stands. Drawn every frame (it rides on live footage, never on twos).

Spec: {type: ring, id, at, until, track: [[t, x, y], ...] frame px (t: seconds from the overlay start), r: [rx, ry],
       width, draw_s, sound (round 2: the sound kind of the stroke, default marker)}"""
import math
import numpy as np
from PIL import Image, ImageDraw
from overlay import kit
from overlay.helpers import marker_and_slide as L


def ev_ring(self, e):
    rx, ry = e['r']
    width = e.get('width', 9)
    t_in, t_out = self.T(e['at']), self.T(e['until'])
    draw_s = e.get('draw_s', 0.45)
    tr = np.array(e['track'], float)
    rng = np.random.default_rng(e.get('seed', 9))
    # one loop and a little overlap, radius wobbling like a hand-drawn ring
    n = 140
    ang = np.linspace(-0.35, 2 * math.pi + 0.25, n) - math.pi / 2
    wob = 1 + 0.05 * np.sin(ang * 2 + rng.uniform(0, 6)) + 0.025 * np.sin(ang * 5 + rng.uniform(0, 6))
    spiral = np.linspace(0.96, 1.05, n)
    pts = [(rx * wob[i] * spiral[i] * math.cos(ang[i]), ry * wob[i] * spiral[i] * math.sin(ang[i])) for i in range(n)]
    red = L.col('accent_red') + (255,)
    size = int(2 * max(rx, ry) * 1.2 + 4 * width)
    cache = {}

    def ring(frac_from, frac_to):
        key = (round(frac_from, 2), round(frac_to, 2))
        if key not in cache:
            im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
            a, b = int(n * frac_from), max(int(n * frac_from) + 1, int(n * frac_to))
            seg = [(size / 2 + x, size / 2 + y) for x, y in pts[a:b + 1]]
            if len(seg) > 1:
                L.marker_line(ImageDraw.Draw(im), seg, red, width, seed=4)
            cache[key] = L.shadow(im, {'dx': 0, 'dy': 3, 'blur': 6, 'opacity': 0.35})
        return cache[key]

    def dyn(tt):
        if tt >= t_out + draw_s:
            return None, 0, 0
        if tt < t_out:
            img, pad = ring(0.0, min(1.0, L.ease_out((tt - t_in) / draw_s)))
        else:  # it fades where it stands: a mark that leaves without travelling (exit-leaves-frame judges moving exits)
            img, pad = ring(0.0, 1.0)
            v = L.ease_in((tt - t_out) / draw_s)
            img = img.copy()
            img.putalpha(img.getchannel('A').point(lambda p: int(p * (1 - v))))
        tp = min(tt, t_out)
        x = np.interp(tp, tr[:, 0], tr[:, 1])
        y = np.interp(tp, tr[:, 0], tr[:, 2])
        return img, x - size / 2 - pad, y - size / 2 - pad
    x0, y0 = tr[:, 1].min() - rx - width, tr[:, 2].min() - ry - width
    x1, y1 = tr[:, 1].max() + rx + width, tr[:, 2].max() + ry + width
    self.safe_box(e.get('id', 'ring'), x0, y0, x1, y1, t_in, t_out)
    sp = kit.SmoothSprite(self, e.get('id', 'ring'), None, 0, 0, t_in, 'none', 0, order=e.get('order', 70), jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    self.sound(e.get('sound', 'marker'), t_in)  # round 2: spec 'sound' picks the stroke (the soft whoosh's energy came before its cue)
