"""widening_circle (round 8, the narrator's analysis beat, option A): a question drawn as growth rings. The first thing he asked
(ice cream) sits on a small paper scrap inside a hand-drawn red marker ring; every thing he went on to ask lands as a paper
scrap on the ring; each time the question gets bigger a new, wider ring is drawn and the scraps ride out to it; then the whole
thing contracts to the centre and clears. Techniques: marker circle (options-ch2/techniques/marker-circle.md, the ring is a
hand-drawn loop in the film's one red), telestrator lines drawn one at a time over a held frame (DEVICES.md "Analysis and
replay"), paper scraps slammed on the word (r3 scrap3).

    {"type": "widening_circle", "id": "q", "center": [1540, 540],
     "core": {"text": "chocolate ice cream", "at": [word, off], "size": 26},
     "rings": [{"at": [word, off], "r": 190}, ...],              the first ring is round the core; later rings are wider
     "scraps": [{"text": "micronutrients", "at": [word, off], "angle": -80, "size": 24, "rot": -3}, ...],   angle: degrees, 0 = right
     "collapse_at": [word, off], "collapse_s": 0.8}

Scraps land at the last ring's radius and stay put while the rings widen out to them. All text is ready the moment its scrap lands
(text-ready-not-late). Nothing is on screen after the collapse (exit-leaves-frame)."""
import math
import numpy as np
from PIL import Image, ImageDraw
import os
import sys
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, ease_in, ease_out
from overlay.helpers.writing_sounds import write_sound
GROW_S = 0.55  # a ring draws on, and the scraps ride out to it, in this many seconds
STROKE = 7


def _ring_points(r, frac, seed, cx, cy):
    """Points of a hand-drawn loop of radius r to fraction frac: a wobbling radius, overshooting its start by 8% like a pen that
    does not stop where it began."""
    rng = np.random.default_rng(seed)
    wob = rng.uniform(-0.018, 0.018, 6)
    th0 = math.radians(205 + seed * 37)
    n = max(2, int(180 * frac))
    pts = []
    for i in range(n):
        th = th0 + 2 * math.pi * 1.08 * i / 179
        k = 1 + sum(w * math.sin((j + 2) * th + j) for j, w in enumerate(wob)) + 0.025 * i / 179
        pts.append((cx + r * k * math.cos(th), cy + r * k * math.sin(th)))
    return pts


def ev_widening_circle(self, e):
    cx, cy = e['center']
    rings = [(self.T(r['at']), r['r']) for r in e['rings']]
    t_col = self.T(e['collapse_at'])
    col_s = e.get('collapse_s', 0.8)
    rmax = max(r for _, r in rings) + 40
    red = kit.col('accent_red') + (235,)
    sid = e.get('id', 'q')
    first_t = min([rings[0][0], self.T(e['core']['at'])])

    def shrink(tt):  # 1 until the collapse, then to 0
        return 1.0 - ease_in(min(max((tt - t_col) / col_s, 0.0), 1.0))

    def radius_at(tt):  # the radius the scraps sit at: the newest ring, eased out from the one before
        r_prev, r_now, k = rings[0][1], rings[0][1], 1.0
        for i, (t_i, r_i) in enumerate(rings):
            if tt >= t_i:
                r_prev = rings[i - 1][1] if i else r_i
                r_now, k = r_i, ease_out(min((tt - t_i) / GROW_S, 1.0))
        return (r_prev + (r_now - r_prev) * k) * shrink(tt)

    cache = {}

    def ring_img(tt):
        s = shrink(tt)
        if s <= 0.02:
            return None, 0, 0
        parts = []
        for i, (t_i, r_i) in enumerate(rings):
            if tt >= t_i:
                parts.append((i, round(min((tt - t_i) / GROW_S, 1.0), 2), int(r_i * s)))
        if not parts:
            return None, 0, 0
        key = (tuple(parts), round(s, 2))
        if key not in cache:
            S = 2  # drawn at twice the size, then scaled down: a smooth line
            half = int(rmax * S) + 30
            im = Image.new('RGBA', (2 * half, 2 * half), (0, 0, 0, 0))
            d = ImageDraw.Draw(im)
            for i, f, r in parts:
                d.line(_ring_points(r * S, f, i + 3, half, half), fill=red, width=STROKE * S, joint='curve')
            cache.clear()
            cache[key] = im.resize((half, half), Image.LANCZOS)
        im = cache[key]
        return im, cx - im.width / 2, cy - im.height / 2
    sp = SmoothSprite(self, sid + '-ring', None, 0, 0, rings[0][0], 'none', 0, order=e.get('order', 60), jitter=False)
    sp.dynamic = ring_img
    self.add(sp)
    for k, (t_i, _) in enumerate(rings):
        write_sound(self, k, t_i)

    def scrap(text, size, rot, seed):
        img = self.paper_text_img(text, size, 'crumpled', seed).rotate(-rot, expand=True, resample=Image.BICUBIC)
        return stage.shadowed(img, look.R['card']['shadow'])

    def faded(img, s):
        a = np.asarray(img).copy()
        a[..., 3] = (a[..., 3] * min(1.0, s * 3)).astype(np.uint8)
        return Image.fromarray(a, 'RGBA')

    # the core scrap: the first thing he asked, in the middle
    c = e['core']
    self.seed += 1
    core, pad = scrap(c['text'], c.get('size', 26), c.get('rot', -2), self.seed)
    t_core = self.T(c['at'])
    self.safe_box(sid + '-core', *self.opaque_box(core, cx - core.width / 2, cy - core.height / 2), t_core)

    t_strike = self.T(c['strike_at']) if c.get('strike_at') is not None else None
    struck = core.copy()
    if t_strike is not None:  # a red marker line through the first thing he asked, on "never"
        ImageDraw.Draw(struck).line([(pad + 6, core.height // 2 + 10), (core.width - pad - 6, core.height // 2 - 10)], fill=kit.col('accent_red') + (255,), width=9)
        play_marker = True

    def core_dyn(tt):
        s = shrink(tt)
        img = struck if (t_strike is not None and tt >= t_strike) else core
        return (faded(img, s) if s < 0.33 else img), cx - core.width / 2, cy - core.height / 2
    sp = stage.Sprite(sid + '-core', None, 0, 0, t_core, 'slam', look.R['card']['slam_s'], order=e.get('order', 60) + 2, jitter=False)
    sp.dynamic = core_dyn
    self.add(sp)
    self.sound('paper', t_core)
    if t_strike is not None:
        write_sound(self, len(rings) + 1, t_strike)

    # the scraps riding the ring
    for k, s_ in enumerate(e['scraps']):
        self.seed += 1
        img, pad = scrap(s_['text'], s_.get('size', 24), s_.get('rot', 0), self.seed)
        t_s = self.T(s_['at'])
        ang = math.radians(s_['angle'])
        r_end = rings[-1][1]
        self.safe_box(f'{sid}-s{k}', *self.opaque_box(img, cx + r_end * math.cos(ang) - img.width / 2, cy + r_end * math.sin(ang) - img.height / 2), t_s)

        def dyn(tt, img=img, ang=ang):
            s = shrink(tt)
            if s <= 0.02:
                return None, 0, 0
            r = r_end * shrink(tt)  # lands where the last ring will reach and stays put; the rings widen out to it (movement-slow-and-small)
            return (faded(img, s) if s < 0.33 else img), cx + r * math.cos(ang) - img.width / 2, cy + r * math.sin(ang) - img.height / 2
        sp = stage.Sprite(f'{sid}-s{k}', None, 0, 0, t_s, 'slam', look.R['card']['slam_s'], order=e.get('order', 60) + 1, jitter=False)
        sp.dynamic = dyn
        self.add(sp)
        self.sound('paper', t_s)
    self.sound('slide_out', t_col)
