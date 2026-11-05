"""Helpers for the ch5 lane's event files (lane ch5 owns this file; it defines no event).

slide(self, sid, picture, x, y, t_in, t_out, ...)   one piece that slides in from an edge (or, enter='wipe', grows out of its own
                                                    left edge through a soft wipe), sits perfectly still while it is up
                                                    (synthetic-469527071d0e), and slides out until it has fully left the frame
                                                    (synthetic-722e3f7861f5). A smooth move, so it carries motion blur along its
                                                    travel (synthetic-4015c76f9424: a camera-world move on every frame, 180
                                                    degree shutter); pieces in a stop-motion style pass blur=False.
marker_stroke(d, pts, colour, width, seed)          a real marker or highlighter line: uneven width along the stroke, ragged
                                                    ends, and the ink darker where the stroke doubles back (synthetic-43b5689d4046).
ease_out_back(u)                                    an ease into place that overshoots a little and settles (a quick landing).
"""
import math
import os
import random
import sys

from PIL import Image, ImageDraw
from overlay import stage
from overlay.kit import SmoothSprite, ease_in, ease_out

from overlay.helpers import paper_pieces as K
from overlay.helpers.motion_smear import FRAME_S, smear



def ease_out_back(u, s=1.35):
    u = min(max(u, 0.0), 1.0) - 1
    return 1 + u * u * ((s + 1) * u + s)


def slide(self, sid, picture, x, y, t_in, t_out, enter='right', exit='right', enter_s=0.38, exit_s=0.34, order=60,
          blur=True, check=True):
    """picture(tt) -> RGBA (shadow included) resting with its top-left at (x, y). Enter: eased out from beyond the named edge
    (or 'none': it is there at t_in). Exit: eased in until it is past the named edge, then it is gone."""
    probe = picture(max(t_in, t_out - 0.05))
    if check:
        self.safe_box(sid, *self.opaque_box(probe, x, y), t_in, t_out)
    w, h = probe.size

    def away(kind):
        return {'right': (stage.W - x + 60, 0), 'left': (-(x + w + 60), 0), 'top': (0, -(y + h + 60)), 'up': (0, -(y + h + 60)),
                'bottom': (0, stage.H - y + 60), 'down': (0, stage.H - y + 60), 'none': (0, 0), 'wipe': (0, 0)}[kind]

    def offset(tt):
        if tt < t_in:
            return None
        if tt < t_in + enter_s and enter != 'none':
            v = 1 - ease_out((tt - t_in) / enter_s)
            ax, ay = away(enter)
            return ax * v, ay * v
        if tt < t_out:
            return 0.0, 0.0
        u = (tt - t_out) / exit_s
        if u >= 1:
            return None
        ax, ay = away(exit)
        return ax * ease_in(u), ay * ease_in(u)

    def dyn(tt):
        o = offset(tt)
        if o is None:
            return None, 0, 0
        img = picture(min(tt, t_out))
        if enter == 'wipe' and tt < t_in + enter_s:
            img = wiped(img, ease_out((tt - t_in) / enter_s))
        px, py = x + o[0], y + o[1]
        p = offset(tt - FRAME_S)
        if blur and p is not None and (abs(o[0] - p[0]) + abs(o[1] - p[1])) >= 3:
            return smear(img, px, py, o[0] - p[0], o[1] - p[1])
        return img, px, py

    sp = SmoothSprite(self, sid, None, 0, 0, t_in, 'none', 0, order=order, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    return sp


def wiped(img, u, soft=48):
    """img revealed from its left edge to fraction u of its width, through a soft edge `soft` px wide (a broadcast wipe:
    the plate grows out of its left edge; the soft edge is the wipe's own blur)."""
    w, h = img.size
    edge = u * (w + soft)
    ramp = Image.new('L', (w, 1))
    ramp.putdata([max(0, min(255, int(255 * (edge - i) / soft))) for i in range(w)])
    a = img.getchannel('A')
    out = img.copy()
    out.putalpha(Image.composite(a, Image.new('L', (w, h), 0), ramp.resize((w, h))))
    return out


def marker_stroke(d, pts, colour, width, seed=1, alpha=235):
    """Draw a marker line through pts (list of (x, y)) on ImageDraw d: the nib's width wobbles along the stroke, the ends are
    ragged, and every dab overlaps the last, so where the line is slow or doubles back the ink builds up darker."""
    rnd = random.Random(seed)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        L = max(1.0, math.hypot(x1 - x0, y1 - y0))
        n = int(L / 2) + 1
        for k in range(n):
            u = k / n
            px, py = x0 + (x1 - x0) * u, y0 + (y1 - y0) * u
            r = width / 2 * (0.82 + 0.3 * rnd.random())
            jy = rnd.uniform(-0.6, 0.6)
            d.ellipse([px - r, py - r * 0.8 + jy, px + r, py + r * 0.8 + jy], fill=colour + (alpha,))


def partial(pts, frac):
    """The first frac (0..1) of a polyline, by length."""
    if frac >= 1:
        return list(pts)
    seg = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
    goal, out = sum(seg) * max(0.0, frac), [pts[0]]
    for (a, b), L in zip(zip(pts, pts[1:]), seg):
        if goal <= L:
            u = goal / L if L else 0
            out.append((a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u))
            return out
        out.append(b)
        goal -= L
    return out
