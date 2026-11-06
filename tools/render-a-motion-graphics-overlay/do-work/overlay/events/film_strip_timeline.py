"""film_strip_timeline (lane ch2, round 2, 4:47 "animal or vegan" B): a strip of 35 mm film runs across the top right of the
frame with his own photos as its frames, older to the left, newer to the right (a timeline you can scrub), and moves the
way he talks: it advances from the animal camp to the vegan camp on the hinge, runs back to a cave painting on "for a
long time", fast-forwards to the present with a film-burn flash on "now come thousands of years later", and pushes in to
the real nutrition labels from his own groceries on "the science behind every food item". The sprocket holes are real
holes (the picture shows through); every frame carries a little film grain and gate weave. A caption under the gate
carries his words. Techniques: his editor list (8 mm film overlays, film burn transitions "like Gawx Art", Johnny Harris
editing, map zoom / push-in), timeline scrub (awesome-ai-motion #401); filmcraft/options-ch2/work-round-2/pick-m07.md.

    {"type": "film_strip_timeline", "id": "strip",
     "frames": [{"image": path, "crop": [x0, y0, x1, y1] (optional), "focus": [fx, fy], "age": 0..1}, ...],
     "gate": [x, y],                          screen centre of the frame at the gate (scale 1)
     "moves": [{"at": s, "to": index, "dur": s}, ...],   frame index at the gate (first move = where it enters)
     "spans": [{"at": s, "out": s}, ...],     the strip slides in from the right and is pulled up out of the top; it can come back
     "captions": [{"text": "...", "at": s, "out": s}, ...],
     "burn": [{"at": s, "dur": s}],           film-burn flash over the gate
     "push": [{"at": s, "scale": 2.0, "gate": [x, y], "dur": s}],   push in: the gate frame grows and moves to `gate`
     "fade_x": [x0, x1]}                      the strip comes out of nothing between these screen x (keeps it off his face)
"""
import math

import numpy as np
from PIL import Image, ImageDraw
from overlay import kit, look, stage
from overlay.kit import SmoothSprite

from overlay.helpers.table_objects import ease_io, ease_out, ease_in, load_photo, rounded, with_blur, FRAME_S
from overlay.helpers.sound_classes import play

Q = 2                      # the strip is drawn at twice its base size so the push-in stays sharp
FW, FH = 360, 252          # frame window, base px
PITCH = FW + 28            # frame to frame along the strip
EDGE = 36                  # film edge with sprocket holes, above and below the frames
SH = FH + 2 * EDGE         # strip height
BASE = (24, 19, 17)        # film base, dark warm


def _cover(im, w, h, focus):
    sc = max(w / im.width, h / im.height)
    nw, nh = int(math.ceil(im.width * sc)), int(math.ceil(im.height * sc))
    im = im.resize((nw, nh), Image.LANCZOS)
    x0 = int(min(max(focus[0] * nw - w / 2, 0), nw - w))
    y0 = int(min(max(focus[1] * nh - h / 2, 0), nh - h))
    return im.crop((x0, y0, x0 + w, y0 + h))


def _grade(im, age):
    """Warm film print; `age` (0..1) adds sepia, lift and vignette for a frame that stands for long ago."""
    a = np.asarray(im.convert('RGB'), np.float32) / 255.0
    a = a * np.array([1.03, 1.0, 0.94]) + 0.015
    if age > 0:
        lum = a @ np.array([0.3, 0.59, 0.11])
        sep = np.stack([lum * 1.07, lum * 0.92, lum * 0.72], -1)
        a = a * (1 - 0.7 * age) + sep * 0.7 * age
        a = a * (1 - 0.12 * age) + 0.06 * age
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    v = 1 - (0.28 + 0.25 * age) * (((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2) ** 1.4
    a = a * np.clip(v, 0, 1)[..., None]
    return Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8), 'RGB')


def _strip(frames):
    """The whole strip at Q x base size: film base, sprocket holes cut through (transparent), photos in the windows."""
    n = len(frames)
    W, H = int((n * PITCH + 40) * Q), int(SH * Q)
    alpha = Image.new('L', (W, H), 246)
    rgb = Image.new('RGB', (W, H), BASE)
    d = ImageDraw.Draw(alpha)
    hole_w, hole_h, hole_pitch = 14 * Q, 20 * Q, 26 * Q
    for x in range(int(8 * Q), W - hole_w, int(hole_pitch)):
        for y in (int(7 * Q), H - int(7 * Q) - hole_h):
            d.rounded_rectangle([x, y, x + hole_w, y + hole_h], 3 * Q, fill=0)
    for i, f in enumerate(frames):
        x = int((20 + i * PITCH) * Q)
        y = int(EDGE * Q)
        pic = _grade(_cover(load_photo(f['image'], f.get('crop')).convert('RGB'), FW * Q, FH * Q, f.get('focus', [0.5, 0.5])),
                     f.get('age', 0))
        pic = rounded(pic, 4 * Q)
        rgb.paste(pic.convert('RGB'), (x, y), pic.getchannel('A'))
        d.rounded_rectangle([x, y, x + FW * Q, y + FH * Q], 4 * Q, fill=255)
    im = rgb.convert('RGBA')
    im.putalpha(alpha)
    return im


def ev_film_strip_timeline(self, e):
    sid = e.get('id', 'strip')
    T = self.T
    frames = e['frames']
    strip = _strip(frames)
    gx, gy = e['gate']
    moves = [(T(m['at']), m['to'], m.get('dur', 0.45)) for m in e['moves']]
    spans = [(T(s['at']), T(s['out'])) for s in e['spans']]
    pushes = [(T(p['at']), p['scale'], p['gate'], p.get('dur', 0.55)) for p in e.get('push', [])]
    burns = [(T(b['at']), b.get('dur', 1.2)) for b in e.get('burn', [])]
    fx0, fx1 = e.get('fade_x', [1180, 1320])
    rng = np.random.default_rng(7)
    grain = [Image.fromarray(np.clip(rng.normal(128, 22, (int(SH * Q), 512)), 0, 255).astype(np.uint8), 'L') for _ in range(6)]

    def index_at(tt):
        idx = float(moves[0][1])
        for t, to, dur in moves[1:]:
            if tt < t:
                break
            idx += (to - idx) * ease_io((tt - t) / dur)
        return idx

    def span_offset(tt):
        """x offset of the whole strip for its slide in from the right; None while it is away (it leaves upward: lift)."""
        for a, b in spans:
            if a <= tt < b + 0.5:
                if tt < a + 0.45:
                    return (1 - ease_out((tt - a) / 0.45)) * 760
                return 0.0
        return None

    def lift(tt):
        """y offset of the strip's exit: it is pulled up out of the top of the frame (a long strip run sideways never clears
        the frame: earlier frames keep entering), 1000 px so the strip and its blur trail are gone before it stops drawing."""
        for a, b in spans:
            if b <= tt < b + 0.5:
                return -ease_in((tt - b) / 0.5) * 1000
        return 0.0

    def view(tt):
        s, cx, cy = 1.0, gx, gy
        for t, sc, (px, py), dur in pushes:
            if tt >= t:
                u = ease_out((tt - t) / dur)          # quick ease in, settle (the person's rules purposeful-camera-curves)
                s, cx, cy = s + (sc - s) * u, cx + (px - cx) * u, cy + (py - cy) * u
        return s, cx, cy

    def anchor(tt):
        off = span_offset(tt)
        if off is None:
            return None
        return gx + off - index_at(tt) * PITCH, gy + lift(tt)

    total_w = strip.width / Q

    def dyn(tt):
        off = span_offset(tt)
        if off is None:
            return None, 0, 0
        idx = index_at(tt)
        s, cx, cy = view(tt)
        weave = math.sin(tt * 37.0) * 0.6 + math.sin(tt * 11.0) * 0.4      # gate weave, under a pixel
        # strip x of the gate frame's centre, base px
        sx_gate = 20 + idx * PITCH + FW / 2
        # screen x of strip x = cx + off + (strip_x - sx_gate) * s ; visible screen x from fx0 to the right edge
        left_strip = sx_gate + (fx0 - cx - off) / s
        right_strip = sx_gate + (stage.W - cx - off) / s
        a, b = max(0.0, left_strip), min(total_w, right_strip)
        if b <= a:
            return None, 0, 0
        piece = strip.crop((int(a * Q), 0, int(math.ceil(b * Q)), strip.height))
        g = grain[int(tt * 23.976) % len(grain)]
        if piece.width > 0:
            gt = g.resize((piece.width, piece.height)) if g.width < piece.width else g.crop((0, 0, piece.width, piece.height))
            arr = np.asarray(piece, np.float32)
            n = (np.asarray(gt, np.float32) - 128) * 0.35
            arr[..., :3] = np.clip(arr[..., :3] + n[..., None], 0, 255)
            piece = Image.fromarray(arr.astype(np.uint8), 'RGBA')
        k = s / Q
        out = piece.resize((max(1, int(piece.width * k)), max(1, int(piece.height * k))), Image.BILINEAR)
        x = cx + off + (a - sx_gate) * s
        y = cy - SH * s / 2 + weave + lift(tt)
        # comes out of nothing between fx0 and fx1 (screen x): the strip never crosses his face
        al = np.asarray(out.getchannel('A'), np.float32)
        xs = x + np.arange(out.width)
        ramp = np.clip((xs - fx0) / max(1, fx1 - fx0), 0, 1)
        out.putalpha(Image.fromarray((al * ramp[None, :]).astype(np.uint8)))
        # film burn: a warm bloom over the gate while it runs fast
        for t, dur in burns:
            if t <= tt < t + dur:
                u = (tt - t) / dur
                amt = math.sin(u * math.pi) ** 1.5
                bw, bh = out.width, out.height
                yy, xx = np.mgrid[0:bh, 0:bw]
                gxl = (cx + off - x)
                r = np.hypot((xx - gxl) / (bw * 0.45), (yy - bh / 2) / (bh * 0.9))
                glow = np.clip(1 - r, 0, 1) ** 1.6 * amt
                arr = np.asarray(out, np.float32)
                warm = np.array([255, 150, 60], np.float32)
                arr[..., :3] = arr[..., :3] * (1 - glow[..., None] * 0.85) + warm * glow[..., None] * 0.85
                arr[..., 3] = np.maximum(arr[..., 3], glow * 200 * (arr[..., 3] > 0))
                out = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), 'RGBA')
        p = anchor(tt)
        return with_blur(out, x, y, p, anchor(tt - 1.5 * FRAME_S))

    sp = SmoothSprite(self, sid, None, 0, 0, spans[0][0], 'none', 0, order=45, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    for a, b in spans:
        self.safe_box(sid, fx0, gy - SH / 2, stage.W - 58, gy + SH / 2, a, b)
        play(self, 'ch2_card', a)
        play(self, 'ch2_out', b)
    for t, to, dur in moves[1:]:
        if dur > 0.8:
            play(self, 'ch2_line' if to < moves[0][1] else 'ch2_out', t, max_s=min(0.7, dur))
        else:
            play(self, 'ch2_slide', t)
    for t, sc, _, dur in pushes:
        play(self, 'ch2_slide', t)

    # ---------- captions under the gate ----------
    fnt = kit.sf('display_semibold', e.get('caption_size', 46))
    for n, c in enumerate(e.get('captions', [])):
        t_in, t_c_out = T(c['at']), T(c['out'])
        im, pad = kit.text_img(c['text'], fnt, (255, 255, 255), shadow=True, align='left')
        bw, bh = im.width + 44, im.height + 22
        pill = Image.new('RGBA', (bw, bh), (0, 0, 0, 0))
        ImageDraw.Draw(pill).rounded_rectangle([0, 0, bw - 1, bh - 1], 20, fill=(14, 12, 11, 215))
        pill.alpha_composite(im, (22, 11))
        x_right = e.get('caption_right', stage.W - 70)
        y_top = gy + SH / 2 + 18
        x0 = x_right - bw
        self.safe_box(f'{sid}-cap{n}', x0, y_top, x_right, y_top + bh, t_in, t_c_out)

        def cap_dyn(tt, pill=pill, x0=x0, y_top=y_top, t_in=t_in, t_c_out=t_c_out):
            if tt < t_in or tt >= t_c_out + 0.2:
                return None, 0, 0
            u = ease_out((tt - t_in) / 0.22)
            v = 1.0 if tt < t_c_out else 1 - (tt - t_c_out) / 0.2
            a = max(0.0, min(u, v))
            img = pill if a >= 0.999 else pill.copy()
            if a < 0.999:
                img.putalpha(img.getchannel('A').point(lambda q: int(q * a)))
            return img, x0, y_top + (1 - u) * 10
        sp = SmoothSprite(self, f'{sid}-cap{n}', None, 0, 0, t_in, 'none', 0, order=55, jitter=False)
        sp.dynamic = cap_dyn
        self.add(sp)
        play(self, 'ch2_in', t_in)
