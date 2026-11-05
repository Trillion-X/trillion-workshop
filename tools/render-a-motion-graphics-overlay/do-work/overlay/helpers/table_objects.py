"""Helpers for lane ch2's 4:47 events (camps_collage, film_strip_timeline); not an event file (load_events skips names
starting with _). Real-object pieces: photo cut-outs with a contact shadow, masking-tape labels written on in marker,
a real-highlighter stroke (multiply ink with ragged ends, the person's rules real-highlighter-look) and a slide with motion blur
(the person's rules motion-blur-fits-style: photos and paper thrown across a table move smoothly, so they blur)."""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps
from overlay import kit, look, stage

from overlay.helpers.motion_smear import smear

FRAME_S = 1001 / 24000
INK = (24, 24, 27)
TAPE = (238, 228, 200)
HIGHLIGHT = {'green': (124, 236, 96), 'yellow': (255, 232, 64), 'red': (255, 92, 92)}


def marker_font(size):
    return kit.face('PermanentMarker-Regular.ttf', size)


def ease_io(u):
    u = min(max(u, 0.0), 1.0)
    return u * u * (3 - 2 * u)


def ease_out(u):
    u = min(max(u, 0.0), 1.0)
    return 1 - (1 - u) ** 3


def ease_in(u):
    u = min(max(u, 0.0), 1.0)
    return u ** 3


def load_photo(path, crop=None):
    im = ImageOps.exif_transpose(Image.open(path)).convert('RGBA')
    return im.crop(tuple(crop)) if crop else im


def fit_h(im, h):
    return im.resize((max(1, int(im.width * h / im.height)), int(h)), Image.LANCZOS)


def fit_w(im, w):
    return im.resize((int(w), max(1, int(im.height * w / im.width))), Image.LANCZOS)


def contact_shadow(im, dy=10, blur=16, opacity=0.5):
    """A photo or cut-out lying on the frame: soft shadow offset down, the object on top. Returns (image, pad)."""
    pad = int(blur * 3 + dy + 4)
    out = Image.new('RGBA', (im.width + 2 * pad, im.height + 2 * pad), (0, 0, 0, 0))
    sa = Image.new('L', out.size, 0)
    sa.paste(im.getchannel('A'), (pad, pad + dy))
    sa = sa.filter(ImageFilter.GaussianBlur(blur)).point(lambda v: int(v * opacity))
    sh = Image.new('RGBA', out.size, (0, 0, 0, 0))
    sh.putalpha(sa)
    out.alpha_composite(sh)
    out.alpha_composite(im, (pad, pad))
    return out, pad


def rounded(im, r):
    m = Image.new('L', im.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, im.width - 1, im.height - 1], r, fill=255)
    out = im.convert('RGBA')
    out.putalpha(Image.fromarray(np.minimum(np.asarray(out.getchannel('A')), np.asarray(m))))
    return out


def torn_tape(w, h, seed):
    """Cream masking tape with torn (zig-zag) short ends and a little transparency."""
    rng = np.random.default_rng(seed)
    pts = [(0, 0)]
    for y in np.linspace(0, h, 7)[1:-1]:
        pts.append((rng.uniform(0, 7), y))
    pts += [(0, h), (w, h)]
    for y in np.linspace(h, 0, 7)[1:-1]:
        pts.append((w - rng.uniform(0, 7), y))
    pts.append((w, 0))
    m = Image.new('L', (w, h), 0)
    ImageDraw.Draw(m).polygon(pts, fill=236)
    tex = (rng.normal(0, 5, (h, w, 1)) + np.array(TAPE)).clip(0, 255).astype(np.uint8)
    im = Image.fromarray(tex, 'RGB').convert('RGBA')
    im.putalpha(m)
    return im


def tape_label(text, size, seed, pad=(22, 12)):
    """Masking-tape label with the words in marker. Returns (tape image, text mask image, text box x0, x1) so the caller can
    write the words on left to right."""
    fnt = marker_font(size)
    lines = text.split('\n')
    asc, desc = fnt.getmetrics()
    lh = int((asc + desc) * 0.98)
    tw = int(max(fnt.getlength(l) for l in lines))
    w, h = tw + 2 * pad[0], lh * len(lines) + 2 * pad[1]
    tape = torn_tape(w, h, seed)
    ink = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(ink)
    for i, l in enumerate(lines):
        d.text((pad[0], pad[1] + i * lh - int(size * 0.08)), l, font=fnt, fill=INK + (255,))
    return tape, ink, lines, lh, pad


def write_on(tape, ink, lines, lh, pad, u):
    """Tape with its words revealed to fraction u of their length, line by line (a write-on at pen speed)."""
    out = tape.copy()
    if u <= 0:
        return out
    fnt_w = ink.width - 2 * pad[0]
    total = sum(max(1, len(l)) for l in lines)
    shown = u * total
    m = Image.new('L', ink.size, 0)
    d = ImageDraw.Draw(m)
    acc = 0
    for i, l in enumerate(lines):
        n = max(1, len(l))
        f = min(max((shown - acc) / n, 0), 1)
        if f > 0:
            d.rectangle([0, pad[1] + i * lh - 10, pad[0] + fnt_w * f + 2, pad[1] + (i + 1) * lh + 6], fill=255)
        acc += n
    a = np.minimum(np.asarray(ink.getchannel('A')), np.asarray(m))
    piece = ink.copy()
    piece.putalpha(Image.fromarray(a))
    out.alpha_composite(piece)
    return out


def marker_path(points, width, colour, u, seed=3):
    """A hand-drawn marker line along points, drawn on to fraction u of its length; slight wobble so it is not a vector."""
    rng = np.random.default_rng(seed)
    pts = np.array(points, np.float32)
    pts = pts + rng.normal(0, 1.2, pts.shape)
    seg = np.hypot(*np.diff(pts, axis=0).T)
    L = seg.sum() * min(max(u, 0), 1)
    xs, ys = [pts[:, 0].min(), pts[:, 0].max()], [pts[:, 1].min(), pts[:, 1].max()]
    pad = width * 2
    im = Image.new('RGBA', (int(xs[1] - xs[0] + 2 * pad), int(ys[1] - ys[0] + 2 * pad)), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    acc, out = 0.0, [tuple(pts[0])]
    for i, s in enumerate(seg):
        if acc + s >= L:
            f = (L - acc) / max(s, 1e-6)
            out.append(tuple(pts[i] + (pts[i + 1] - pts[i]) * f))
            break
        out.append(tuple(pts[i + 1]))
        acc += s
    if len(out) > 1:
        q = [(x - xs[0] + pad, y - ys[0] + pad) for x, y in out]
        d.line(q, fill=colour + (255,), width=int(width), joint='curve')
        r = width / 2
        for x, y in (q[0], q[-1]):
            d.ellipse([x - r, y - r, x + r, y + r], fill=colour + (255,))
    return im, xs[0] - pad, ys[0] - pad


def highlighter(card_rgb, box, colour, u, seed):
    """A real highlighter pass over box (card px) on the card, drawn left to right to fraction u: ragged ends and uneven
    ink (r2.brush_stroke), laid down as multiply ink so the printed words stay dark under it."""
    x0, y0, x1, y1 = box
    L, H = x1 - x0, y1 - y0
    stroke, pad = kit.brush_stroke(L, H, seed, (255, 255, 255))
    a = np.asarray(stroke.getchannel('A'), np.float32) / 255.0 * 0.85
    shown = int(pad + L * min(max(u, 0), 1) + pad * (1 if u >= 1 else 0))
    a[:, shown:] = 0
    img = np.asarray(card_rgb.convert('RGBA'), np.float32).copy()
    ox, oy = int(x0 - pad), int(y0 - pad)
    hh, ww = a.shape
    sx0, sy0 = max(0, ox), max(0, oy)
    sx1, sy1 = min(img.shape[1], ox + ww), min(img.shape[0], oy + hh)
    if sx1 <= sx0 or sy1 <= sy0:
        return card_rgb
    aa = a[sy0 - oy:sy1 - oy, sx0 - ox:sx1 - ox, None]
    c = np.array(HIGHLIGHT[colour], np.float32) / 255.0
    region = img[sy0:sy1, sx0:sx1, :3]
    img[sy0:sy1, sx0:sx1, :3] = region * (1 - aa * (1 - c))
    return Image.fromarray(img.clip(0, 255).astype(np.uint8), 'RGBA')


def with_blur(img, x, y, pos_now, pos_before):
    """Motion blur from the element's travel over the last 1.5 frames (pos functions give (x, y) of its anchor)."""
    if pos_before is None:
        return img, x, y
    dx, dy = pos_now[0] - pos_before[0], pos_now[1] - pos_before[1]
    if math.hypot(dx, dy) < 3:
        return img, x, y
    return smear(img, x, y, dx, dy, trail=0.0)


def scaled(img, s):
    if abs(s - 1) < 1e-3:
        return img
    return img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))), Image.BILINEAR)


def dimmed(img, amount):
    """Inactive side: less colour and a little darker (amount 0..1)."""
    if amount <= 0:
        return img
    rgb = img.convert('RGB')
    grey = ImageOps.grayscale(rgb).convert('RGB')
    mix = Image.blend(rgb, grey, 0.75 * amount)
    mix = Image.eval(mix, lambda v: int(v * (1 - 0.28 * amount)))
    out = mix.convert('RGBA')
    out.putalpha(img.getchannel('A'))
    return out
