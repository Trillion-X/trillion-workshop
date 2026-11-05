"""branch_map (lane ch2): one source word, and a hand-drawn line growing out of it to each thing it becomes, each line
arriving as he names that thing (technique: source-result mapping, awesome-ai-motion; filmcraft/options-ch2/techniques/branch-map.md).

White SF Pro over footage with the soft wide shadow (text-face, synthetic-bcc8a5f2f6a9). Every frame is drawn at the film's
own frame rate (no stop-motion stepping on lines over footage).

    {"type": "branch_map", "id": "root-word",
     "root": {"text": "root word", "pos": [x, y], "size": 66, "at": s},    or {"image": cut-out.png, "h": 300, "pos", "at",
                                                                       "anchor": "bottom"}: a real object as the source,
                                                                       lines leave from its bottom edge instead of its right
     "leaves": [{"text": "yogurt", "pos": [x, y], "at": s, "size": 40}, ...],  at = when the word is said; the line starts
     "leaf_size": 52, "draw_s": 0.4, "lead_s": 0.3,                   lead_s earlier and lands on the word
     "out": s, "out_dir": "W"}                                         everything leaves together in one direction
"""
import math
import numpy as np
from PIL import Image, ImageDraw
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, compass, ease_in, ease_out
from overlay.helpers.motion_smear import smeared
from overlay.helpers.sound_classes import play


def _curve(p0, p1, bend, n=48):
    """Points of a gentle quadratic curve from p0 to p1; bend is the control point's offset across the chord (px)."""
    mx, my = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    L = math.hypot(dx, dy) or 1
    cx, cy = mx - dy / L * bend, my + dx / L * bend
    return [((1 - u) ** 2 * p0[0] + 2 * (1 - u) * u * cx + u * u * p1[0],
             (1 - u) ** 2 * p0[1] + 2 * (1 - u) * u * cy + u * u * p1[1]) for u in np.linspace(0, 1, n)]


def _stroke(pts, frac, width, box):
    """RGBA of the first frac of a polyline (white, round ends), with the text's soft shadow, in a frame-sized layer."""
    x0, y0, x1, y1 = box
    im = Image.new('RGBA', (int(x1 - x0), int(y1 - y0)), (0, 0, 0, 0))
    k = max(2, int(round(frac * (len(pts) - 1))) + 1)
    seg = [(x - x0, y - y0) for x, y in pts[:k]]
    d = ImageDraw.Draw(im)
    d.line(seg, fill=(255, 255, 255, 255), width=width, joint='curve')
    for p in (seg[0], seg[-1]):
        d.ellipse([p[0] - width / 2, p[1] - width / 2, p[0] + width / 2, p[1] + width / 2], fill=(255, 255, 255, 255))
    return stage.shadowed(im, look.LOOK['text_shadow'])


def ev_branch_map(self, e):
    sid = e.get('id', 'branch')
    fnt_root = kit.sf('display_bold', e['root'].get('size', 66))
    fnt_leaf = kit.sf('display_semibold', e.get('leaf_size', 52))
    white = kit.col('white')
    if e['root'].get('image'):
        src = Image.open(e['root']['image']).convert('RGBA')
        h = e['root']['h']
        src = src.resize((max(1, int(src.width * h / src.height)), h), Image.LANCZOS)
        root_im, rpad = stage.shadowed(src, {'dx': 0, 'dy': 10, 'blur': 18, 'opacity': 0.42})
    else:
        root_im, rpad = kit.text_img(e['root']['text'], fnt_root, white)
    rx, ry = e['root']['pos']
    t_root = self.T(e['root']['at'])
    t_out = self.T(e['out'])
    ox, oy = compass(e.get('out_dir', 'W'))
    draw_s, lead_s = e.get('draw_s', 0.4), e.get('lead_s', 0.3)

    def leave(tt):
        if tt < t_out:
            return 0.0, 0.0
        u = ease_in((tt - t_out) / 0.45)
        return (None, None) if u >= 1 else (ox * u, oy * u)

    def moved(x, y, tt):
        dx, dy = leave(tt)
        return (None, None) if dx is None else (x + dx, y + dy)

    def fade_rise(im, x, y, t0):
        def dyn(tt):
            u = ease_out((tt - t0) / 0.18)
            mx, my = moved(x, y + (1 - u) * 12, tt)
            if mx is None:
                return None, 0, 0
            if u < 1:
                im2 = im.copy()
                im2.putalpha(im.getchannel('A').point(lambda v: int(v * u)))
                return im2, mx, my
            return im, mx, my
        return dyn

    sp = SmoothSprite(self, sid + '-root', None, 0, 0, t_root, 'none', 0, order=60, jitter=False)
    sp.dynamic = smeared(fade_rise(root_im, rx - rpad, ry - rpad, t_root), leave)
    self.add(sp)
    self.safe_box(sid + '-root', rx, ry, rx + root_im.width - 2 * rpad, ry + root_im.height - 2 * rpad, t_root, t_out)
    play(self, 'ch2_in', t_root)
    rw, rh = root_im.width - 2 * rpad, root_im.height - 2 * rpad
    start = (rx + rw / 2, ry + rh + 14) if e['root'].get('anchor') == 'bottom' else (rx + rw + 14, ry + rh * 0.55)
    for k, lf in enumerate(e['leaves']):
        im, pad = kit.text_img(lf['text'], kit.sf('display_semibold', lf['size']) if lf.get('size') else fnt_leaf, white)
        lx, ly = lf['pos']
        t_word = self.T(lf['at'])
        end = (lx - 16, ly + (im.height - 2 * pad) * 0.55)
        pts = _curve(start, end, lf.get('bend', (k - (len(e['leaves']) - 1) / 2) * -18))
        box = (min(p[0] for p in pts) - 10, min(p[1] for p in pts) - 10, max(p[0] for p in pts) + 10, max(p[1] for p in pts) + 10)
        t_line = t_word - lead_s
        cache = {}

        def line_dyn(tt, pts=pts, box=box, t_line=t_line, cache=cache):
            frac = min(1.0, ease_out((tt - t_line) / draw_s))
            key = round(frac, 3)
            if key not in cache:
                if len(cache) > 3:
                    cache.clear()
                cache[key] =_stroke(pts, frac, e.get('line_px', 5), box)
            img, p = cache[key]
            mx, my = moved(box[0] - p, box[1] - p, tt)
            return (None, 0, 0) if mx is None else (img, mx, my)
        ls = SmoothSprite(self, f'{sid}-line{k}', None, 0, 0, t_line, 'none', 0, order=58, jitter=False)
        ls.dynamic = smeared(line_dyn, leave)
        self.add(ls)
        play(self, 'ch2_line', t_line, max_s=draw_s + 0.15)  # a soft glide, not the scratchy marker (the person 2026-10-21)
        ws = SmoothSprite(self, f'{sid}-leaf{k}', None, 0, 0, t_word, 'none', 0, order=60, jitter=False)
        ws.dynamic = smeared(fade_rise(im, lx - pad, ly - pad, t_word), leave)
        self.add(ws)
        self.safe_box(f'{sid}-leaf{k}', lx, ly, lx + im.width - 2 * pad, ly + im.height - 2 * pad, t_word, t_out)
        play(self, 'ch2_in', t_word)
    play(self, 'ch2_out', t_out)
