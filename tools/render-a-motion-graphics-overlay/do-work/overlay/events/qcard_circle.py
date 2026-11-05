"""qcard_circle (lane ch2): the chapter-1 question card (r3 qcard3: whole question from the first frame, slides in, real
crumple out) brought back as a callback, with one hand-drawn marker loop drawn round one of its lines on the word that names
it (technique: marker circle; filmcraft/options-ch2/techniques/marker-circle.md). The loop is in the film's one red (look_r2 accent_red,
the same red as the strike-through: a correction mark). It is drawn on the card itself, so the crumple folds the card with
the loop on it.

    qcard3's fields, plus {"circle_line": 4, "mark_at": s, "mark_s": 0.55}
    circle_line: index of the text line to circle (0 = first line of `text`)
"""
import math
import numpy as np
from PIL import Image, ImageDraw
from overlay import kit, look, stage
from overlay.kit import ease_out
from overlay.helpers.sound_classes import play


def _line_box(flat, index):
    """Box (x0, y0, x1, y1) of the index-th line of ink on a flat card: rows holding dark ink, grouped into runs."""
    a = np.asarray(flat.convert('RGBA')).astype(int)
    ink = (a[..., :3].sum(2) < 260) & (a[..., 3] > 200)
    rows = ink.sum(1) > 2
    runs, start = [], None
    for y, r in enumerate(rows):
        if r and start is None:
            start = y
        if not r and start is not None:
            runs.append((start, y))
            start = None
    runs = [r for r in runs if r[1] - r[0] > 6]
    y0, y1 = runs[index]
    cols = np.nonzero(ink[y0:y1].any(0))[0]
    return cols[0], y0, cols[-1], y1


def _loop(box, frac, seed, size):
    """RGBA (size) with the first frac of a hand-drawn loop round box: an ellipse with a wobbling radius, overshooting its
    start by 8% like a pen that does not stop exactly where it began."""
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rx, ry = (x1 - x0) / 2 + 26, (y1 - y0) / 2 + 7  # flat: the lines above and below sit close
    rng = np.random.default_rng(seed)
    wob = rng.uniform(-0.02, 0.02, 6)
    th0 = math.radians(200)
    n = max(2, int(140 * frac))
    pts = []
    for i in range(n):
        th = th0 + 2 * math.pi * 1.08 * i / 139
        k = 1 + sum(w * math.sin((j + 2) * th + j) for j, w in enumerate(wob)) + 0.03 * i / 139
        pts.append((cx + rx * k * math.cos(th), cy + ry * k * math.sin(th)))
    im = Image.new('RGBA', size, (0, 0, 0, 0))
    ImageDraw.Draw(im).line(pts, fill=kit.col('accent_red') + (235,), width=6, joint='curve')
    return im


def ev_qcard_circle(self, e):
    t_mark = self.T(e['mark_at'])
    mark_s = e.get('mark_s', 0.55)
    paper_text_img = self.paper_text_img
    seen = {}

    def card_with_loop(text, size, paper, seed, *a, **k):
        flat = paper_text_img(text, size, paper, seed, *a, **k)
        if text == e['text'] and 'flat' not in seen:
            seen['flat'], seen['box'] = flat, _line_box(flat, e['circle_line'])
        return flat
    self.paper_text_img = card_with_loop
    crumple_frames = self.crumple_frames

    def crumple_with_loop(flat, rot, seed, seconds):  # the card that crumples carries the finished loop
        f2 = flat.copy()
        f2.alpha_composite(_loop(seen['box'], 1.0, 11, flat.size))
        return crumple_frames(f2, rot, seed, seconds)
    self.crumple_frames = crumple_with_loop
    n0 = len(self.sprites)
    self.ev_qcard3(e)
    self.paper_text_img, self.crumple_frames = paper_text_img, crumple_frames
    sp = self.sprites[n0]
    flat, rot = seen['flat'], e.get('rot', 0)
    shown_flat = flat.rotate(-rot, expand=True, resample=Image.BICUBIC)
    full = stage.shadowed(shown_flat, look.R['card']['shadow'])[0]
    base_dyn = sp.dynamic
    cache = {}

    def dyn(tt):
        img, x, y = base_dyn(tt)
        if img is None or tt < t_mark or img.size != full.size:  # the crumple frames already carry the loop
            return img, x, y
        frac = min(1.0, ease_out((tt - t_mark) / mark_s))
        key = round(frac, 3)
        if key not in cache:
            if len(cache) > 3:
                cache.clear()
            c = flat.copy()
            c.alpha_composite(_loop(seen['box'], frac, 11, flat.size))
            cache[key] = stage.shadowed(c.rotate(-rot, expand=True, resample=Image.BICUBIC), look.R['card']['shadow'])[0]
        return cache[key], x, y
    sp.dynamic = dyn
    play(self, 'ch2_line', t_mark, max_s=mark_s + 0.1)  # a soft glide under the loop, not the scratchy marker
