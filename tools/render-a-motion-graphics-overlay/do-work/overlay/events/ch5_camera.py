"""ch5_camera (lane ch5): the camera as a character in the comedy of 17:00-17:20 (make-the-moment). Two events.

power_cut: the camera dies on screen. Over a frame hold the last frame before his cut ("image": that frame of the graded
cut, rendered by FilmCraft) collapses the way an old CRT set switches off: the picture squashes to a bright horizontal line,
the line pulls in to a dot, the dot fades; black; an empty battery blinks; then the next take switches on the same way in
reverse, a thin bright slit opening to the full frame (technique: CRT power-off and power-on, after the After Effects
"TV turn off" tutorials: a vertical scale to ~1% with a brightness bloom, then a horizontal scale to a point, about 0.2 s
each; library/techniques/camera-died-moment.md).

    {"type": "power_cut", "id": "dead", "image": "<png>", "at": s, "collapse_s": 0.30, "dot_s": 0.22,
     "battery": {"at": s, "blinks": 2}, "on_at": s, "on_s": 0.22}

stat_bug: a broadcast-style counter plate (a sports stat bug) that drops in from the top, counts on its cue with an
odometer roll, and leaves the way it came; also used as a two-beat caption plate (line 2 lands on its own word).

    {"type": "stat_bug", "id": "count", "pos": [x, y], "at": s, "out": s, "label": "Sneeze count",
     "counts": [{"n": 1, "at": s}, {"n": 2, "at": s}]}
    {"type": "stat_bug", "id": "kit", "pos": [x, y], "at": s, "out": s, "lines": [{"text": "Kittens?", "at": s}, ...]}

clip_inset: his own clip in a framed inset of the same package (the broadcast "cam" box), with caption lines under it on the
plate, while his talk keeps playing beside it. The clip plays every frame at `speed` and holds its last frame.

    {"type": "clip_inset", "id": "kit", "src": "<clip>", "start": 0.0, "speed": 0.8, "pos": [x, y], "w": 720, "at": s,
     "out": s, "lines": [{"text": "Kittens?", "at": s}, {"text": "...", "at": s}]}

A dark plate with a red tally edge (the colour of a camera's REC light), white SF Pro on it, so it reads over any footage.
Slides with motion blur (smooth moves), still while it is up. Sounds: plate in, a click per count or line, plate out."""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter
from overlay import kit, look
from overlay import stage
from overlay.kit import ClipReader, SmoothSprite, ease_in, ease_out
from overlay.stage import FPS

from overlay.helpers import paper_pieces as K
from overlay.helpers import slide_pieces as C

PLATE = (20, 20, 22, 236)
TALLY = (226, 38, 38)
WHITE = (255, 255, 255)


def ev_power_cut(self, e):
    sid = e.get('id', 'dead')
    T = self.T
    W, H = stage.W, stage.H
    frame = Image.open(e['image']).convert('RGB').resize((W, H), Image.LANCZOS)
    t0 = T(e['at'])
    t_col, t_dot = t0 + e.get('collapse_s', 0.30), t0 + e.get('collapse_s', 0.30) + e.get('dot_s', 0.22)
    bat = e['battery']
    t_bat, blinks = T(bat['at']), bat.get('blinks', 2)
    t_on, on_s = T(e['on_at']), e.get('on_s', 0.22)
    black = Image.new('RGBA', (W, H), (0, 0, 0, 255))
    battery = battery_icon(150)
    bright = Image.eval(frame, lambda v: min(255, int(v * 1.35 + 40)))
    cache = {}

    def squash(u):
        """The picture at vertical scale 1 - u (u 0..1), brightening as it thins, centred on a black frame."""
        h = max(2, int(round(H * (1 - 0.995 * u))))
        img = Image.blend(frame, bright, min(1.0, u * 1.4)).resize((W, h), Image.BILINEAR)
        out = black.copy()
        out.paste(img, (0, (H - h) // 2))
        if u > 0.6:  # the bloom of a thin bright line
            glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
            ImageDraw.Draw(glow).rectangle([0, H // 2 - 6, W, H // 2 + 6], fill=(235, 240, 255, int(200 * (u - 0.6) / 0.4)))
            out.alpha_composite(glow.filter(ImageFilter.GaussianBlur(9)))
        return out

    def line_to_dot(u):
        """The bright line pulls in to a dot (u 0..1), then the dot fades."""
        out = black.copy()
        g = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(g)
        half = max(4, int(W / 2 * (1 - ease_in(min(1.0, u * 1.5)))))
        a = int(255 * (1 - max(0.0, (u - 0.66) / 0.34)))
        d.rectangle([W // 2 - half, H // 2 - 3, W // 2 + half, H // 2 + 3], fill=(240, 244, 255, a))
        d.ellipse([W // 2 - 9, H // 2 - 9, W // 2 + 9, H // 2 + 9], fill=(255, 255, 255, a))
        out.alpha_composite(g.filter(ImageFilter.GaussianBlur(5)))
        out.alpha_composite(g)
        return out

    def battery_frame(on):
        out = black.copy()
        if on:
            out.alpha_composite(battery, ((W - battery.width) // 2, (H - battery.height) // 2))
        return out

    def opening(u):
        """Power on: a transparent slit in the black opens from the centre line to the full height, its edges glowing."""
        h = int(H * ease_out(u))
        out = black.copy()
        if h > 0:
            ImageDraw.Draw(out).rectangle([0, (H - h) // 2, W, (H + h) // 2], fill=(0, 0, 0, 0))
        edge = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        e_a = int(220 * (1 - u))
        ImageDraw.Draw(edge).rectangle([0, (H - h) // 2 - 3, W, (H - h) // 2 + 3], fill=(240, 244, 255, e_a))
        ImageDraw.Draw(edge).rectangle([0, (H + h) // 2 - 3, W, (H + h) // 2 + 3], fill=(240, 244, 255, e_a))
        out.alpha_composite(edge.filter(ImageFilter.GaussianBlur(4)))
        return out

    def dyn(tt):
        if tt < t0 or tt >= t_on + on_s:
            return None, 0, 0
        if tt < t_col:
            key = ('sq', round((tt - t0) / (t_col - t0), 2))
            make = lambda: squash(ease_in(key[1]))
        elif tt < t_dot:
            key = ('dot', round((tt - t_col) / (t_dot - t_col), 2))
            make = lambda: line_to_dot(key[1])
        elif tt < t_on:
            k = int((tt - t_bat) / 0.3) if tt >= t_bat else -1
            key = ('bat', 0 <= k < 2 * blinks and k % 2 == 0)
            make = lambda: battery_frame(key[1])
        else:
            key = ('on', round((tt - t_on) / on_s, 2))
            make = lambda: opening(key[1])
        if key not in cache:
            if len(cache) > 8:
                cache.pop(next(iter(cache)))
            cache[key] = make()
        return cache[key], 0, 0

    sp = SmoothSprite(self, sid, None, 0, 0, t0, 'none', 0, order=95, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('power_off', t0)
    for k in range(blinks):
        self.sound('battery_blink', t_bat + 0.6 * k)
    self.sound('power_on', t_on)


def battery_icon(w):
    """An empty battery, a camera's 'battery exhausted' sign: white outline, red sliver at the left end."""
    h = int(w * 0.48)
    im = Image.new('RGBA', (w + 20, h + 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([4, 4, w - 6, h + 2], radius=12, outline=WHITE + (255,), width=8)
    d.rounded_rectangle([w - 2, h // 2 - h // 5, w + 14, h // 2 + h // 5 + 4], radius=4, fill=WHITE + (255,))
    d.rounded_rectangle([18, 18, 18 + w // 9, h - 12], radius=4, fill=TALLY + (255,))
    return im


def ev_stat_bug(self, e):
    sid = e.get('id', 'bug')
    T = self.T
    fl = kit.sf('text_semibold', e.get('label_px', 30))
    fn = kit.sf('display_bold', e.get('num_px', 76))
    ft = kit.sf('display_bold', e.get('text_px', 54))
    t_in, t_out = T(e['at']), T(e['out'])
    pad, edge = 26, 12
    if 'counts' in e:
        counts = [(c['n'], T(c['at'])) for c in e['counts']]
        lw = int(fl.getlength(e['label']))
        nw = max(int(fn.getlength(str(n))) for n, _ in counts)
        W, H = edge + pad + lw + 30 + nw + pad, int(fn.size * 1.45)
    else:
        lines = [(ln['text'], T(ln['at'])) for ln in e['lines']]
        W = edge + pad + max(int(ft.getlength(t)) for t, _ in lines) + pad
    cache = {}

    def plate(h):
        im = Image.new('RGBA', (W, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.rounded_rectangle([0, 0, W - 1, h - 1], radius=10, fill=PLATE)
        d.rounded_rectangle([0, 0, edge + 8, h - 1], radius=10, fill=TALLY + (255,))
        d.rectangle([edge, 0, edge + 8, h - 1], fill=PLATE)
        return im, d

    def counter(tt):
        k = max([i for i, (_, at) in enumerate(counts) if tt >= at] or [0])
        roll = min(1.0, max(0.0, (tt - counts[k][1]) / 0.2)) if k > 0 else 1.0
        key = (k, round(roll, 2))
        if key in cache:
            return cache[key]
        im, d = plate(H)
        d.text((edge + pad, H / 2), e['label'], font=fl, fill=WHITE + (235,), anchor='lm')
        nx = W - pad - nw
        num = Image.new('RGBA', (nw + 4, H), (0, 0, 0, 0))
        nd = ImageDraw.Draw(num)
        u = ease_out(roll)
        if k > 0 and roll < 1:  # odometer roll: the old number goes up and out as the new one comes up into place
            nd.text((0, H / 2 - u * H), str(counts[k - 1][0]), font=fn, fill=WHITE + (255,), anchor='lm')
        nd.text((0, H / 2 + (1 - u) * H), str(counts[k][0]), font=fn, fill=WHITE + (255,), anchor='lm')
        im.alpha_composite(num, (nx, 0))
        out = stage.shadowed(im, look.LOOK['text_shadow'])[0]
        cache[key] = out
        return out

    def caption(tt):
        """The plate is as tall as the lines it shows; a new line grows it down over 0.15 s, and the line is whole when it shows."""
        n = max(1, sum(1 for _, at in lines if tt >= at))
        g = min(1.0, (tt - lines[n - 1][1]) / 0.15) if n > 1 else 1.0
        key = (n, round(ease_out(max(0.0, g)), 2))
        if key in cache:
            return cache[key]
        h = int(30 + 70 * (n - 1) + 70 * key[1]) if n > 1 else 100
        im, d = plate(h)
        for i, (text, _) in enumerate(lines[:n]):
            if i < n - 1 or key[1] >= 1.0:
                d.text((edge + pad, 18 + 70 * i), text, font=ft, fill=WHITE + (255,))
        out = stage.shadowed(im, look.LOOK['text_shadow'])[0]
        cache[key] = out
        return out

    picture = counter if 'counts' in e else caption
    x, y = e['pos']
    C.slide(self, sid, picture, x, y, t_in, t_out, enter=e.get('enter', 'top'), exit=e.get('exit', 'top'), order=70)
    self.sound('card_in', t_in)
    for _, at in (counts[1:] if 'counts' in e else lines[1:]):
        self.sound('count_tick', at)
    self.sound('card_out', t_out)


def ev_clip_inset(self, e):
    sid = e.get('id', 'inset')
    T = self.T
    W = e.get('w', 720)
    vw, vh = W - 32, int((W - 32) * 9 / 16)  # the clip sits between the tally edge (20 px) and a 12 px margin
    ft = kit.sf('display_bold', e.get('text_px', 50))
    lines = [(ln['text'], T(ln['at'])) for ln in e['lines']]
    t_in, t_out = T(e['at']), T(e['out'])
    rd = ClipReader(e['src'], e.get('start', 0.0), (vw, vh), speed=e.get('speed', 1.0))
    edge, pad, lh = 12, 26, 66

    def picture(tt):
        n = sum(1 for _, at in lines if tt >= at)
        H = 12 + vh + 12 + (18 + lh * n if n else 0)
        im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.rounded_rectangle([0, 0, W - 1, H - 1], radius=12, fill=PLATE)
        d.rounded_rectangle([0, 0, edge + 8, H - 1], radius=12, fill=TALLY + (255,))
        d.rectangle([edge, 0, edge + 8, H - 1], fill=PLATE)
        frame = rd.get(max(0, int(round((tt - t_in) * FPS)))).convert('RGBA')
        im.alpha_composite(frame, (edge + 8, 12))
        for i, (text, _) in enumerate(lines[:n]):
            d.text((edge + pad, 12 + vh + 18 + lh * i), text, font=ft, fill=WHITE + (255,))
        return stage.shadowed(im, look.LOOK['text_shadow'])[0]

    x, y = e['pos']
    C.slide(self, sid, picture, x, y, t_in, t_out, enter=e.get('enter', 'top'), exit=e.get('exit', 'top'), order=72)
    self.sound('card_in', t_in)
    for _, at in lines:
        self.sound('count_tick', at)
    self.sound('card_out', t_out)
