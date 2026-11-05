"""Shared pieces for the ch3 lane's event files (lane ch3 owns this file; it defines no event).

paper(w, h, kind, seed)      a paper piece: 'index' (white index card, red head rule, blue rules), 'cream', 'kraft', 'white',
                             'label' (white label stock); torn or straight edge; texture from the recipe
hand(text, face, size)       ink lettering on a transparent layer (marker or pen faces in narrator/assets/fonts)
reveal(img, frac)            the first frac of img from the left (a hand writing it on, or a line drawn across)
moving(self, sid, ...)       one sprite whose picture comes from a function of time, entering and leaving by moving
                             (slide in from an edge, drop, rise), drifting 2 px over about 6 s while it sits
                             (synthetic-9fb8b6e064f4, his round-5 pick), and leaving until it is fully off frame
                             (synthetic-722e3f7861f5). Its resting opaque box is checked against the title-safe area.
                             blur=True (smooth pieces): motion blur matched to speed, a 180-degree shutter
                             (synthetic-4015c76f9424); stop-motion and paper-on-twos pieces keep blur off.
                             Paper exits (paper_exits=True, the event's exit sound through leave_sound): exit "crumple"
                             (the piece's own face crumpled by crumple.py, the ball falls) or "tear" (torn in two down a
                             jagged seam, the halves turn apart and drop); both schedule their own real-recording sounds.
leave_sound(self, exit, t)   the exit sound after moving(): nothing for a paper exit, else the event's slide sound
motion_blur(img, dx, dy)     img smeared along the move (dx, dy) it makes during the shutter; returns (img, ox, oy)
highlighter(w, h, colour)    a real highlighter stroke: chisel ends, uneven edges, streaks along the pull, darker ink where
                             it starts and lifts (synthetic-43b5689d4046); HL colours by meaning (red bad, green good,
                             yellow neutral)
highlight_onto(base, box, colour, frac, seed)
                             the stroke multiplied onto paper under its words, written on left to right to frac
"""
import math
import os
import numpy as np
from PIL import Image, ImageDraw
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, ease_in, ease_out, face
from overlay.look import LOOK3
INK = kit.col('ink')
RED = kit.col('accent_red')
DRIFT = {'px': 2, 'period_s': 6.0}  # his round-5 note: slow drift the whole time, small travel (04 E / 09 E)
FPS = 24000 / 1001
# synthetic-7fa0ebeb0ee3 (paper world): a paper piece can leave by being crumpled into a ball that falls (the real Blender
# crumple of r3 crumple.py on the piece's own face) or torn in two down a jagged seam, the halves turning apart and dropping
PAPER_EXITS = ('crumple', 'tear')
CRUMPLE_S = 0.55
TEAR = {'s': 0.45, 'spread_px': 40, 'turn_deg': 12, 'seam_jag_px': 9, 'drop_after_s': 0.12}
HL = {'red': (255, 84, 92), 'yellow': (255, 226, 64), 'green': (122, 222, 110), 'blue': (110, 190, 255)}


def paper(w, h, kind='cream', seed=1, edge='torn', rules=None):
    """rules (index cards): (y of the red head rule, line spacing) so the blue rules sit under the written lines."""
    fill = {'index': stage.rgb('paper_white'), 'white': stage.rgb('paper_white'), 'label': (250, 249, 244),
            'cream': stage.rgb('paper_cream'), 'kraft': stage.rgb('kraft')}[kind]
    im = Image.new('RGBA', (w, h), fill + (255,))
    d = ImageDraw.Draw(im)
    if kind == 'index':
        ry, step = rules or (int(h * 0.2), 34)
        d.line([(0, ry), (w, ry)], fill=(222, 120, 120, 255), width=2)
        for y in range(ry + step, h - 8, step):
            d.line([(0, y), (w, y)], fill=(150, 182, 214, 255), width=1)
    im = stage.apply_texture(im, 'kraft' if kind == 'kraft' else 'sheet', seed, 0.3)
    m = Image.new('L', (w, h), 0)
    if edge == 'torn':
        ImageDraw.Draw(m).polygon(stage.torn_polygon(w, h, 3, seed, step=8), fill=255)
    else:
        ImageDraw.Draw(m).rectangle([0, 0, w - 1, h - 1], fill=255)
    im.putalpha(m)
    return im


def hand(text, face_name, size, colour=INK, spacing=1.15):
    fnt = face(face_name, size)
    lines = text.split('\n')
    asc, desc = fnt.getmetrics()
    lh = int((asc + desc) * spacing)
    w = int(max(fnt.getlength(l) for l in lines)) + 8
    im = Image.new('RGBA', (w, lh * len(lines) + 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for i, l in enumerate(lines):
        d.text((4, 4 + i * lh), l, font=fnt, fill=colour + (255,))
    return im


def reveal(img, frac):
    if frac >= 1:
        return img
    out = img.copy()
    a = np.asarray(out.getchannel('A')).copy()
    a[:, int(img.width * max(0.0, frac)):] = 0
    out.putalpha(Image.fromarray(a))
    return out


def shadow(img, soft=False):
    return stage.shadowed(img, {'dx': 2, 'dy': 6, 'blur': 12, 'opacity': 0.35} if soft else look.R['card']['shadow'])


def offset_in(kind, u, x, y, w, h):
    """Where a piece is while entering (u 0..1 of its entry), as an offset from its resting place."""
    v = 1 - ease_out(min(max(u, 0.0), 1.0))
    if kind == 'right':
        return v * (stage.W - x + 40), 0
    if kind == 'left':
        return -v * (x + w + 40), 0
    if kind == 'top':
        return 0, -v * (y + h + 40)
    if kind == 'bottom':
        return 0, v * (stage.H - y + 40)
    return 0, 0


def offset_out(kind, v, x, y, w, h):
    """Offset while leaving (v = seconds since the exit started); None once the piece is fully off frame."""
    if kind == 'fall':  # drops under gravity, turning a little
        dy = 0.5 * 4200 * v * v
        return (v * 60, dy) if y + dy < stage.H + 20 else None
    if kind == 'flick':  # a peeled note flicked away: up and to the left, turning, faster as it goes
        u = ease_in(min(v / 0.5, 1.0))
        d = (-u * (x + w + 120), -u * (y + h + 160) * 0.8)
        return d if u < 1 else None
    if kind == 'rise':
        dy = -0.5 * 4200 * v * v
        return (0, dy) if y + h + dy > -20 else None
    u = ease_in(min(v / 0.42, 1.0))
    d = {'right': (u * (stage.W - x + 60), 0), 'left': (-u * (x + w + 60), 0), 'up': (0, -u * (y + h + 60)),
         'down': (0, u * (stage.H - y + 60))}[kind]
    return d if u < 1 else None


def _paper_only(img):
    """A shadowed piece without its shadow (the shadow is under half opacity, the paper opaque), cropped; and its box in img."""
    a = np.asarray(img.getchannel('A'))
    out = img.copy()
    out.putalpha(Image.fromarray(np.where(a > 200, a, 0).astype(np.uint8)))
    box = out.getbbox()
    return out.crop(box), box


def _dropped(img, cx, cy, v, turn):
    """img centred at cx, cy, v seconds into a fall under gravity (look_r3 fall), turned by turn degrees; None once below the frame."""
    fall = LOOK3['fall']
    im = img.rotate(-turn, expand=True, resample=Image.BICUBIC)
    dy = 0.5 * fall['gravity_px_s2'] * v * v
    if cy + dy - im.height / 2 > stage.H:
        return None
    return im, cx - im.width / 2 + v * fall['drift_px_s'], cy - im.height / 2 + dy


def paper_leave(self, sid, kind, still, x, y, t_out, seed):
    """The paper exit `kind` (PAPER_EXITS) of the shadowed picture `still` resting at x, y: leave(tt) -> (img, x, y), (None, 0, 0)
    once it is out of frame. Schedules its own sounds (real recordings): crumple then fall, or the tear."""
    flat, box = _paper_only(still)
    cx, cy = x + (box[0] + box[2]) / 2, y + (box[1] + box[3]) / 2
    spin = LOOK3['fall']['spin_deg_s']
    if kind == 'crumple':
        frames, meta = self.crumple_frames(flat, 0, seed, CRUMPLE_S)
        n_s = len(frames) / meta['fps']

        def leave(tt):
            k = int((tt - t_out) * meta['fps'])
            if k < len(frames):
                fr = frames[k][0]
                return fr, cx - fr.width / 2, cy - fr.height / 2
            v = tt - t_out - n_s
            return _dropped(frames[-1][0], cx, cy, v, v * spin) or (None, 0, 0)
        self.sound('crumple', t_out)
        self.sound('fall', t_out + n_s)
        return leave
    rng = np.random.default_rng(seed)  # tear: a seam near the middle that wanders, with the small teeth of torn fibres
    w, h = flat.size
    walk = np.cumsum(rng.normal(0, 1.0, h))
    walk = (walk - walk.mean()) / max(1e-6, np.abs(walk - walk.mean()).max()) * TEAR['seam_jag_px']
    seam = (w / 2 + walk + 0.4 * TEAR['seam_jag_px'] * np.sign(np.sin(np.arange(h) / 3.0)))[:, None]
    xs = np.arange(w)[None, :]
    a = np.asarray(flat.getchannel('A'))
    halves = []
    for keep, side in ((xs < seam, -1), (xs >= seam, 1)):
        part = flat.copy()
        part.putalpha(Image.fromarray((a * keep).astype(np.uint8)))
        pb = part.getbbox()
        halves.append((shadow(part.crop(pb))[0], cx - w / 2 + (pb[0] + pb[2]) / 2, cy - h / 2 + (pb[1] + pb[3]) / 2, side))

    def leave(tt):
        v = tt - t_out
        u = ease_out(min(v / TEAR['s'], 1.0))
        drop = max(0.0, v - TEAR['drop_after_s'])
        placed = []
        for im, hx, hy, side in halves:
            got = _dropped(im, hx + side * TEAR['spread_px'] * u, hy, drop, side * (TEAR['turn_deg'] * u + 0.3 * spin * drop))
            if got:
                placed.append(got)
        if not placed:
            return None, 0, 0
        x0, y0 = min(p[1] for p in placed), min(p[2] for p in placed)
        x1, y1 = max(p[1] + p[0].width for p in placed), max(p[2] + p[0].height for p in placed)
        out = Image.new('RGBA', (int(x1 - x0) + 1, int(y1 - y0) + 1), (0, 0, 0, 0))
        for im, px, py in placed:
            out.alpha_composite(im, (int(px - x0), int(py - y0)))
        return out, x0, y0
    self.extra_sounds['tear'] = [look.section('paper_pieces')['tear_sound']]
    self.sound('tear', t_out)
    self.sound('fall', t_out + TEAR['drop_after_s'])
    return leave


def leave_sound(self, exit, t_out, kind='slide_out'):
    """The exit sound of a piece that left through moving(): a paper exit has scheduled its own, any other exit plays kind."""
    if exit not in PAPER_EXITS:
        self.sound(kind, t_out)


def moving(self, sid, picture, x, y, t_in, t_out, enter='right', exit='right', enter_s=0.34, order=60, drift=True, check=True,
           smooth=False, blur=False, paper_exits=False):
    """picture(tt) -> RGBA (already shadowed) at rest position x, y (top-left of the image). smooth: drawn at every frame's
    exact time (lines and words over footage); otherwise on twos like the other paper pieces. blur (smooth pieces): motion
    blur matched to the speed of the move. paper_exits: the event plays its exit sound through leave_sound, so it may leave by
    a paper exit (PAPER_EXITS), which schedules its own sounds."""
    if exit in PAPER_EXITS and not paper_exits:
        raise SystemExit(f'{sid}: exit "{exit}" is a paper exit; this event does not play its exit sound through K.leave_sound')
    k = (sum(map(ord, sid)) % 31) / 30.0
    period = DRIFT['period_s'] * (0.85 + 0.3 * k)
    probe = picture(max(t_in, t_out - 0.05))
    if check:
        self.safe_box(sid, *self.opaque_box(probe, x, y), t_in, t_out)

    def offset(tt, w_, h_):
        dx, dy = offset_in(enter, (tt - t_in) / enter_s if enter_s else 1, x, y, w_, h_)
        if drift and tt > t_in + enter_s:
            ph = 2 * math.pi * (tt - t_in - enter_s) / period
            dx += DRIFT['px'] / 2 * math.sin(ph)
            dy += DRIFT['px'] * 0.3 * math.sin(ph * 0.71 + k * 6)
        if tt >= t_out:
            o = offset_out(exit, tt - t_out, x + dx, y + dy, w_, h_)
            if o is None:
                return None
            dx, dy = dx + o[0], dy + o[1]
        return dx, dy

    leave = None
    if exit in PAPER_EXITS:
        still = picture(t_out)
        rest = offset(t_out - 1e-3, still.width, still.height)
        leave = paper_leave(self, sid, exit, still, x + rest[0], y + rest[1], t_out, sum(map(ord, sid)) % 97)

    def dyn(tt):
        if leave is not None and tt >= t_out:
            return leave(tt)
        img = picture(tt)
        if img is None:
            return None, 0, 0
        o = offset(tt, img.width, img.height)
        if o is None:
            return None, 0, 0
        dx, dy = o
        if tt >= t_out and exit == 'fall':
            img = img.rotate(-(tt - t_out) * 160, expand=True, resample=Image.BICUBIC)
        elif tt >= t_out and exit == 'flick':
            img = img.rotate(min(1.0, (tt - t_out) / 0.5) * 28, expand=True, resample=Image.BICUBIC)
        if blur:
            before = offset(tt - 0.5 / FPS, img.width, img.height)
            if before is not None:
                img, ox, oy = motion_blur(img, dx - before[0], dy - before[1])
                return img, x + dx + ox, y + dy + oy
        return img, x + dx, y + dy
    sp = SmoothSprite(self, sid, None, 0, 0, t_in, 'none', 0, order=order, jitter=False) if smooth else \
        stage.Sprite(sid, None, 0, 0, t_in, 'none', 0, order=order, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    return sp


def motion_blur(img, dx, dy):
    """img smeared along (dx, dy), the path it covers while the shutter is open, centred on where it is now. Returns the
    blurred image and the offset of its top-left from img's. Under 1.5 px of travel nothing is done."""
    dist = math.hypot(dx, dy)
    if dist < 1.5:
        return img, 0, 0
    n = int(min(24, max(3, dist / 3)))
    pad_x, pad_y = int(abs(dx) / 2) + 2, int(abs(dy) / 2) + 2
    a = np.asarray(img).astype(np.float32)
    a[..., :3] *= a[..., 3:4] / 255.0  # premultiplied, so edges do not darken
    acc = np.zeros((img.height + 2 * pad_y, img.width + 2 * pad_x, 4), np.float32)
    for i in range(n):
        f = i / (n - 1) - 0.5
        ox, oy = int(round(pad_x - f * dx)), int(round(pad_y - f * dy))
        acc[oy:oy + img.height, ox:ox + img.width] += a
    acc /= n
    rgb = np.where(acc[..., 3:4] > 0, acc[..., :3] * 255.0 / np.maximum(acc[..., 3:4], 1e-3), 0)
    out = np.dstack([np.clip(rgb, 0, 255), np.clip(acc[..., 3], 0, 255)]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA'), -pad_x, -pad_y


def highlighter(w, h, colour='red', seed=1):
    """A highlighter stroke w x h: chisel-cut ends, edges that wander a little, faint streaks along the pull, and darker ink
    where the pen lands and lifts (a second pass of ink). RGBA, colour from HL by meaning."""
    rng = np.random.default_rng(seed)
    c = np.array(HL.get(colour, colour), np.float32)
    xs = np.arange(w)
    top = 2 + 2.2 * np.sin(xs / max(18, w / 6) + rng.uniform(0, 6)) + np.cumsum(rng.normal(0, 0.12, w))
    bot = h - 3 + 2.2 * np.sin(xs / max(22, w / 5) + rng.uniform(0, 6)) + np.cumsum(rng.normal(0, 0.12, w))
    top -= top.mean() - 3
    bot -= bot.mean() - (h - 3)
    yy = np.arange(h)[:, None]
    inside = (yy >= top[None, :]) & (yy <= bot[None, :])
    slant = int(h * 0.28)  # chisel tip: the ends are cut on a slant
    for x_ in range(min(slant, w)):
        inside[:int((slant - x_) * h / slant / 2), x_] = False
        inside[h - int((slant - x_) * h / slant / 2):, w - 1 - x_] = False
    streak = 0.9 + 0.1 * np.sin(yy * 1.7 + rng.uniform(0, 6)) * (0.6 + 0.4 * rng.random((h, 1)))
    ends = 1 + 0.35 * (np.exp(-xs / (h * 0.6)) + np.exp(-(w - 1 - xs) / (h * 0.6)))[None, :]
    alpha = np.clip(inside * 0.7 * streak * ends, 0, 0.92)
    edge = np.clip(np.minimum(yy - top[None, :], bot[None, :] - yy), 0, 2) / 2  # soft 2 px edge
    alpha *= 0.65 + 0.35 * edge
    out = np.zeros((h, w, 4), np.float32)
    out[..., :3] = c
    out[..., 3] = alpha * 255
    return Image.fromarray(out.astype(np.uint8), 'RGBA')


def highlight_onto(base, box, colour='red', frac=1.0, seed=1):
    """Multiply a highlighter stroke into base (paper, RGBA) over box (x0, y0, x1, y1), written on left to right to frac,
    so the paper's grain and the words over it show through as with real ink. base is changed in place."""
    if frac <= 0:
        return base
    x0, y0, x1, y1 = [int(v) for v in box]
    stroke = highlighter(x1 - x0, y1 - y0, colour, seed)
    if frac < 1:
        stroke = reveal(stroke, frac)
    region = np.asarray(base.crop((x0, y0, x1, y1))).astype(np.float32)
    s = np.asarray(stroke).astype(np.float32)
    a = s[..., 3:4] / 255.0
    mult = region[..., :3] * s[..., :3] / 255.0
    region[..., :3] = region[..., :3] * (1 - a) + mult * a
    base.paste(Image.fromarray(region.astype(np.uint8), 'RGBA'), (x0, y0))
    return base


def image_piece(path, w, crop=None):
    """An image file scaled to width w (RGBA kept)."""
    im = Image.open(path).convert('RGBA')
    if crop:
        im = im.crop(tuple(crop))
    return im.resize((w, int(im.height * w / im.width)), Image.LANCZOS)


def text_layout(text, fnt, width):
    """Wrap text into lines no wider than width; returns (lines, boxes) where boxes[i] = (line, x0, x1) for every word i
    in reading order, so a phrase can be found and marked."""
    words = text.split(' ')
    lines, cur, boxes, line_no = [], '', [], 0
    for wd in words:
        trial = (cur + ' ' + wd).strip()
        if cur and fnt.getlength(trial) > width:
            lines.append(cur)
            cur, line_no = wd, line_no + 1
        else:
            cur = trial
        x1 = fnt.getlength(cur)
        boxes.append((line_no, x1 - fnt.getlength(wd), x1))
    lines.append(cur)
    return lines, boxes
