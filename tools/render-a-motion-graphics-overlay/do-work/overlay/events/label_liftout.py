"""label_liftout (lane ch2, round 2): the real document, then the lines that matter lifted out of it and highlighted.
A real label or page image lands in the free space and settles still (synthetic-469527071d0e); on the word, the region
that matters grows out of it into a larger excerpt beside it (zoom callout: the source stays, a lens grows from it,
awesome-ai-motion #319), and a real-looking highlighter runs along each line in turn on the word (Vox highlighter as
taught by Premiere Gal and FlatpackFX: a slightly uneven hand-drawn stroke, multiplied into the paper so the ink sits
behind the black type, drawn on by its end point; colour by meaning, green for good).
filmcraft/options-ch2/assets/r2-m05/technique-label-liftout.md.

    {"type": "label_liftout", "id": "label", "image": path, "crop": [x0, y0, x1, y1],     the document, source pixels
     "box": [x0, y0, x1, y1], "rot": -2.0,                                                 where it settles (frame px)
     "lift": {"crop": [x0, y0, x1, y1], "box": [x0, y0, x1, y1], "at": s,                 region of the document image
              "lines": [[y0, y1], ...], "ink": [r, g, b], "start": s, "step": s}},       highlight rows (lift-crop px)
     "note": {"text": "...", "box": [x0, y0, x1, y1], "at": s, "size": 32},                  the sum the label leaves to the
     "at": s, "out": s, "in_dir": "E", "out_dir": "E"}                                     reader, done on screen (optional)
"""
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, compass, ease_in, ease_out
from overlay.helpers.motion_smear import smeared
from overlay.helpers.sound_classes import play

PAPER_SHADOW = {'dx': 0, 'dy': 12, 'blur': 24, 'opacity': 0.5}


def _unit(d):
    vx, vy = compass(d)
    n = max(1e-6, math.hypot(vx, vy))
    return vx / n, vy / n


def _to_leave(vx, vy, box):
    x0, y0, x1, y1 = box
    far = [(stage.W + 80 - x0) / vx if vx > 0 else (x1 + 80) / -vx if vx < 0 else 1e9,
           (stage.H + 80 - y0) / vy if vy > 0 else (y1 + 80) / -vy if vy < 0 else 1e9]
    return min(far)


def _stroke_alpha(w, h, seed):
    """Alpha of one highlighter stroke, w x h: chisel-cut ends, edges that wander a pixel or two, a faint streak texture
    along the stroke and a little more ink where the nib lands and lifts."""
    rng = np.random.default_rng(seed)
    a = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(a)
    slant = h * 0.32
    n = max(4, w // 24)
    top = [(slant + (w - slant) * i / n, 1 + rng.uniform(-1.6, 1.6)) for i in range(n + 1)]
    bot = [(w - slant - (w - slant) * i / n, h - 2 + rng.uniform(-1.6, 1.6)) for i in range(n + 1)]
    d.polygon([(0, h - 2)] + top + [(w, 1)] + bot, fill=255)
    a = a.filter(ImageFilter.GaussianBlur(0.8))
    arr = np.asarray(a, np.float32) / 255.0
    streak = 1.0 + 0.07 * np.repeat(rng.normal(0, 1, (h, 1)), w, axis=1)  # lengthwise texture of the felt tip
    xs = np.arange(w, dtype=np.float32)
    pool = 1.0 + 0.22 * np.exp(-xs / 14.0) + 0.16 * np.exp(-(w - xs) / 10.0)  # ink pools where it lands and lifts
    return np.clip(arr * 0.64 * streak * pool[None, :], 0, 0.95)


def ev_label_liftout(self, e):
    sid = e.get('id', 'label')
    src = ImageOps.exif_transpose(Image.open(e['image'])).convert('RGB')
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    bx0, by0, bx1, by1 = e['box']

    # ---- the document, scaled to its box, turned a little, with a paper shadow; it lands and stays still
    doc = src.crop(tuple(e['crop'])).resize((bx1 - bx0, by1 - by0), Image.LANCZOS).convert('RGBA')
    L = e['lift']
    cx0, cy0, cx1, cy1 = e['crop']
    lx0, ly0, lx1, ly1 = L['crop']
    sx, sy = (bx1 - bx0) / (cx1 - cx0), (by1 - by0) / (cy1 - cy0)
    src_rect = (bx0 + (lx0 - cx0) * sx, by0 + (ly0 - cy0) * sy, bx0 + (lx1 - cx0) * sx, by0 + (ly1 - cy0) * sy)
    t_lift = self.T(L['at'])
    rot = e.get('rot', 0.0)
    doc_rot = doc.rotate(rot, expand=True, resample=Image.BICUBIC)
    doc_img, dpad = stage.shadowed(doc_rot, PAPER_SHADOW)
    ddx, ddy = (doc_rot.width - doc.width) / 2, (doc_rot.height - doc.height) / 2
    marked, mpad = None, 0
    ix, iy = _unit(e.get('in_dir', 'E'))
    ox, oy = _unit(e.get('out_dir', 'E'))
    tin = _to_leave(ix, iy, e['box'])
    tout_doc = _to_leave(ox, oy, e['box'])

    def doc_offset(tt):
        if tt < t_in + 0.42:
            u = 1 - ease_out(max(0.0, tt - t_in) / 0.42)
            return tin * ix * u, tin * iy * u
        if tt < t_out:
            return 0.0, 0.0
        u = ease_in((tt - t_out) / 0.4)
        return (None, None) if u >= 1 else (tout_doc * ox * u, tout_doc * oy * u)

    def doc_dyn(tt):
        nonlocal marked, mpad
        if tt < t_in:
            return None, 0, 0
        dx, dy = doc_offset(tt)
        if dx is None:
            return None, 0, 0
        img, p = doc_img, dpad
        if tt >= t_lift:  # the source of the excerpt stays outlined on the document while the excerpt is up
            if marked is None:
                m = doc.copy()
                ImageDraw.Draw(m).rectangle([src_rect[0] - bx0 - 3, src_rect[1] - by0 - 3, src_rect[2] - bx0 + 3, src_rect[3] - by0 + 3],
                                            outline=(30, 30, 30, 255), width=3)
                marked, mpad = stage.shadowed(m.rotate(rot, expand=True, resample=Image.BICUBIC), PAPER_SHADOW)
            img, p = marked, mpad
        return img, bx0 - ddx - p + dx, by0 - ddy - p + dy

    self.safe_box(sid, bx0, by0, bx1, by1, t_in + 0.42, t_out)
    sp = SmoothSprite(self, sid, None, 0, 0, t_in, 'none', 0, order=60, jitter=False)
    sp.dynamic = smeared(doc_dyn, doc_offset)
    self.add(sp)
    play(self, 'ch2_card', t_in)

    # ---- the excerpt: grows out of its place on the document into its own box, then the highlighter runs line by line
    fx0, fy0, fx1, fy1 = L['box']
    margin = 16
    inner_w, inner_h = fx1 - fx0 - 2 * margin, fy1 - fy0 - 2 * margin
    ex = src.crop(tuple(L['crop'])).resize((inner_w, inner_h), Image.LANCZOS)
    k = inner_w / (lx1 - lx0)
    ink = np.array(L.get('ink', [118, 214, 92]), np.float32) / 255.0
    base = np.asarray(ex, np.float32) / 255.0
    strokes = []
    jit = np.random.default_rng(7)
    for i, (y0, y1) in enumerate(L['lines']):  # a hand never starts or stops two strokes at the same place
        top, bot = int(y0 * k) + int(jit.integers(-2, 3)), int(y1 * k) + int(jit.integers(-2, 3))
        x_from, length = int(jit.integers(0, 12)), inner_w - 8 - int(jit.integers(0, 22))
        strokes.append((max(0, top), min(inner_h, bot), x_from, _stroke_alpha(length - x_from, min(inner_h, bot) - max(0, top), seed=31 + i)))
    t_first, step, draw_s = self.T(L['start']), L.get('step', 0.22), 0.3
    tout_lift = _to_leave(ox, oy, L['box'])
    cache = {}

    def excerpt(tt):
        done = tuple(min(1.0, max(0.0, (tt - (t_first + i * step)) / draw_s)) for i in range(len(strokes)))
        key = tuple(round(v, 3) for v in done)
        if key in cache:
            return cache[key]
        rgb = base.copy()
        for (top, bot, x_from, al), u in zip(strokes, done):
            if u <= 0:
                continue
            reach = int(al.shape[1] * ease_out(u))
            a = al[:, :reach, None]
            x = 4 + x_from
            seg = rgb[top:bot, x:x + reach]
            rgb[top:bot, x:x + reach] = seg * (1 - a + a * ink)  # multiply: the ink sits behind the black type
        face = Image.new('RGBA', (fx1 - fx0, fy1 - fy0), (255, 255, 255, 255))
        face.paste(Image.fromarray(np.clip(rgb * 255, 0, 255).astype(np.uint8), 'RGB'), (margin, margin))
        cache.clear()
        cache[key] = face
        return face

    def lift_geom(tt):
        u = ease_out(min(1.0, max(0.0, (tt - t_lift) / 0.45)))
        r = [src_rect[j] + (L['box'][j] - src_rect[j]) * u for j in range(4)]
        return r, u

    def lift_offset(tt):
        if tt < t_out:
            r, _ = lift_geom(tt)
            r1, _ = lift_geom(t_lift + 0.45)
            return r[0] - r1[0], r[1] - r1[1]
        u = ease_in((tt - t_out) / 0.4)
        return (None, None) if u >= 1 else (tout_lift * ox * u, tout_lift * oy * u)

    def lift_dyn(tt):
        if tt < t_lift:
            return None, 0, 0
        r, u = lift_geom(tt)
        if tt >= t_out:
            dx, dy = lift_offset(tt)
            if dx is None:
                return None, 0, 0
            r = [fx0 + dx, fy0 + dy, fx1 + dx, fy1 + dy]
        w, h = max(8, int(r[2] - r[0])), max(8, int(r[3] - r[1]))
        im = excerpt(tt).resize((w, h), Image.LANCZOS)
        img, p = stage.shadowed(im, PAPER_SHADOW)
        return img, r[0] - p, r[1] - p

    self.safe_box(sid + '-lift', fx0, fy0, fx1, fy1, t_lift + 0.45, t_out)
    sl = SmoothSprite(self, sid + '-lift', None, 0, 0, t_lift, 'none', 0, order=64, jitter=False)
    sl.dynamic = smeared(lift_dyn, lift_offset)
    self.add(sl)
    play(self, 'ch2_slide', t_lift)
    play(self, 'ch2_line', t_first, max_s=0.7)
    play(self, 'ch2_out', t_out)

    # ---- the math the label leaves to the reader, done on screen beside it: a dark note in the free space
    n = e.get('note')
    if not n:
        return
    nx0, ny0, nx1, ny1 = n['box']
    t_note = self.T(n['at'])
    f_note = kit.sf('text_semibold', n.get('size', 32))
    lines = n['text'].split('\n')
    lh = int(sum(f_note.getmetrics()) * 1.15)
    note = Image.new('RGBA', (nx1 - nx0, ny1 - ny0), (0, 0, 0, 0))
    dn = ImageDraw.Draw(note)
    dn.rounded_rectangle([0, 0, nx1 - nx0 - 1, ny1 - ny0 - 1], 18, fill=(20, 20, 22, 238))
    y = (ny1 - ny0 - lh * len(lines)) / 2
    for line in lines:
        dn.text((22, y), line, font=f_note, fill=(255, 255, 255, 255))
        y += lh
    if 22 + max(f_note.getlength(line) for line in lines) > nx1 - nx0 - 16:
        raise SystemExit(f'{sid}: the note does not fit its box')
    note_img, npad = stage.shadowed(note, {'dx': 0, 'dy': 8, 'blur': 20, 'opacity': 0.5})
    tout_note = _to_leave(ox, oy, n['box'])

    def note_offset(tt):
        if tt < t_out:
            u = 1 - ease_out(min(1.0, max(0.0, tt - t_note) / 0.3))
            return 60 * u, 0.0
        u = ease_in((tt - t_out) / 0.4)
        return (None, None) if u >= 1 else (tout_note * ox * u, tout_note * oy * u)

    def note_dyn(tt):
        if tt < t_note:
            return None, 0, 0
        dx, dy = note_offset(tt)
        if dx is None:
            return None, 0, 0
        img = note_img
        u = min(1.0, (tt - t_note) / 0.2)
        if u < 1:
            img = note_img.copy()
            img.putalpha(note_img.getchannel('A').point(lambda v: int(v * u)))
        return img, nx0 - npad + dx, ny0 - npad + dy

    self.safe_box(sid + '-note', nx0, ny0, nx1, ny1, t_note + 0.3, t_out)
    sn = SmoothSprite(self, sid + '-note', None, 0, 0, t_note, 'none', 0, order=66, jitter=False)
    sn.dynamic = smeared(note_dyn, note_offset)
    self.add(sn)
    play(self, 'ch2_in', t_note)
