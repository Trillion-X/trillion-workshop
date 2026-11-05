"""jelly_pouch (lane ch5): the real product he is talking about, as a physical object in his kitchen. A product cut-out falls in
under gravity and lands with squash and stretch; a black tag beside it says what the product is made of; its cap pops off and
the things he wishes were in it drop into the open spout one at a time (each falls under gravity with motion blur, the pouch
gives a little and swells as it takes them in); on a word the pouch is squeezed and a bead of jelly rises out of the spout.
Technique: product-pouch-fill (library/techniques/product-pouch-fill.md), combining a product cut-out explainer, the twelve
principles' squash and stretch on landings, and a gravity drop with a smear frame (_ch2_motion.smear).

    {"type": "jelly_pouch", "id": "dally", "image": ".../dally-pouch.png", "pos": [x, y], "w": 270, "at": s, "land_s": 0.36,
     "out": s, "cap": {"box": [x0, y0, x1, y1], "pop_at": s}, "spout": [x, y], "gel": [r, g, b],
     "tag": {"pos": [x, y], "w": 330, "at": s, "out": s, "lines": [{"text": "...", "at": s, "px": 30, "bold": true}, ...]},
     "drops": [{"text": "protein", "at": s, "sound": "plop1"}, ...], "list": {"pos": [x, y], "w": 330, "at": s, "px": 34} (appears in place with its first line),
     "squeeze": {"at": s, "s": 0.62}}

Image coordinates (cap box, spout) are in the cut-out's own pixels. Times are seconds of the overlay (or word refs). Each drop's
chip starts falling on its word (its list line appears then too) and reaches the spout drop_fall_s (0.45 s) later. Sounds: drop_land (the pouch landing), card_in /
card_out (the tag and the list), cap_pop, each drop's own sound kind (different recordings, never one sound looped), squeeze,
card_out when everything leaves (the pouch falls out of the bottom of the frame, the list slides out to the right)."""
import math
import os
import sys

from PIL import Image, ImageDraw
from overlay import kit
from overlay import stage
from overlay.kit import SmoothSprite, ease_in, ease_out

from overlay.helpers import paper_pieces as K
from overlay.helpers import slide_pieces as C
from overlay.helpers.motion_smear import FRAME_S, smear

WHITE = (255, 255, 255)
SWALLOW_S = 0.28  # a chip going down through the spout's mouth
BLACK = (18, 18, 18)
TAG_SHADOW = {'dx': 0, 'dy': 5, 'blur': 10, 'opacity': 0.4}
POUCH_SHADOW = {'dx': 4, 'dy': 10, 'blur': 14, 'opacity': 0.45}


def clamp(u):
    return min(1.0, max(0.0, u))


def catch(u):
    """0..1 along a drop that speeds up and then is caught: smoothstep, at rest at both ends."""
    u = clamp(u)
    return u * u * (3 - 2 * u)


def bounce(u):
    """Squash after an impact: 0 at the hit, a damped wobble back to rest by u = 1 (two swings)."""
    if u <= 0 or u >= 1:
        return 0.0
    return math.exp(-4.0 * u) * math.cos(2.2 * math.pi * u) * (1 - u)


def ev_jelly_pouch(self, e):
    sid = e.get('id', 'pouch')
    T = self.T
    src = Image.open(e['image']).convert('RGBA')
    W = e['w']
    s0 = W / src.width
    H = int(round(src.height * s0))
    x, y = e['pos']
    t_in, t_out = T(e['at']), T(e['out'])
    land_s = e.get('land_s', 0.36)
    t_land = t_in + land_s
    cap = e.get('cap')
    capbox = cap['box'] if cap else None
    t_pop = T(cap['pop_at']) if cap else 1e9
    cap_img = None
    if cap:  # the cap alone; the cut-out mask's faint fringe around it is dropped so the flying cap is only the cap
        cap_img = src.crop(tuple(capbox))
        cap_img.putalpha(cap_img.getchannel('A').point(lambda v: 0 if v < 60 else v))
    body_cap = src
    body_open = src.copy()
    if cap:  # the pouch without its cap: the cap's pixels cleared, the spout's open mouth drawn where the cap sat
        d = ImageDraw.Draw(body_open)
        d.rectangle(capbox, fill=(0, 0, 0, 0))
        sx, sy = e['spout']
        d.ellipse([sx - 30, sy - 6, sx + 30, sy + 8], fill=(150, 52, 6, 255))
        d.ellipse([sx - 22, sy - 3, sx + 22, sy + 6], fill=(70, 22, 2, 255))
    gel = tuple(e.get('gel', (246, 128, 34)))
    fall_s = e.get('drop_fall_s', 0.45)
    drops = [dict(dr, t=T(dr['at']), hit=T(dr['at']) - 0.05 + fall_s) for dr in e.get('drops', [])]  # each chip starts falling on its word
    sq = e.get('squeeze')
    t_sq = T(sq['at']) if sq else 1e9
    sq_s = sq.get('s', 0.62) if sq else 0
    fall_out_s = e.get('fall_out_s', 0.42)
    spout_x, spout_y = (x + e['spout'][0] * s0, y + e['spout'][1] * s0) if cap else (x + W / 2, y)

    def shape(tt):
        """(width scale, height scale) of the pouch at tt, anchored at its bottom centre."""
        sx = sy = 1.0
        if tt >= t_land:  # landing squash and stretch
            b = bounce((tt - t_land) / 0.5)
            sx, sy = 1 + 0.07 * b, 1 - 0.09 * b
        for dr in drops:  # each drop: a small give, then the pouch is that much fuller
            u = (tt - dr['hit']) / 0.32
            if u > 0:
                b = bounce(u)
                sx *= 1 + 0.03 * b + 0.012 * min(1.0, u * 3)
                sy *= 1 - 0.035 * b
        if t_sq <= tt < t_sq + sq_s:  # squeezed in from the sides, then let go
            u = (tt - t_sq) / sq_s
            p = math.sin(math.pi * u) ** 0.8
            sx *= 1 - 0.11 * p
            sy *= 1 + 0.035 * p
        return sx, sy

    def fall(tt):
        """Vertical offset of the pouch: falling in from above the frame, and out of the bottom of the frame at the end."""
        if tt < t_land:
            u = clamp((tt - t_in) / land_s)
            return -(y + H + 40) * (1 - u * u)  # gravity: distance grows with the square of time
        if tt >= t_out:
            u = clamp((tt - t_out) / fall_out_s)
            return (1080 - y + 60) * u * u
        return 0.0

    cache = {}

    def pouch_img(tt):
        sx, sy = shape(tt)
        opened = tt >= t_pop
        key = (round(sx, 3), round(sy, 3), opened)
        if key not in cache:
            body = body_open if opened else body_cap
            w, h = max(1, int(round(W * sx))), max(1, int(round(H * sy)))
            im = body.resize((w, h), Image.LANCZOS)
            if len(cache) > 40:
                cache.pop(next(iter(cache)))
            cache[key] = stage.shadowed(im, POUCH_SHADOW)
        return cache[key], sx, sy

    def pouch_dyn(tt):
        if tt < t_in or tt >= t_out + fall_out_s:
            return None, 0, 0
        (im, pad), sx, sy = pouch_img(tt)
        dy = fall(tt)
        px = x + W / 2 - im.width / 2
        py = y + H - (H * sy) - pad + dy
        prev = fall(tt - FRAME_S)
        if abs(dy - prev) >= 3:
            return smear(im, px, py, 0, dy - prev)
        return im, px, py

    self.safe_box(sid, x, y, x + W, y + H, t_in, t_out)
    sp = SmoothSprite(self, sid, None, 0, 0, t_in, 'none', 0, order=e.get('order', 58), jitter=False)
    sp.dynamic = pouch_dyn
    self.add(sp)
    self.sound('drop_land', t_land)

    if cap:  # the cap pops off: up and away with a spin, under gravity, out of the top of the frame
        cw, ch = int(cap_img.width * s0), int(cap_img.height * s0)
        cimg = cap_img.resize((cw, ch), Image.LANCZOS)
        cx0, cy0 = x + capbox[0] * s0, y + capbox[1] * s0
        vx, vy, g = 380.0, -950.0, 2300.0

        def cap_pos(tt):
            u = tt - t_pop
            return cx0 + vx * u, cy0 + vy * u + 0.5 * g * u * u, 140 * u

        def cap_dyn(tt):
            if tt < t_pop or tt > t_pop + 1.2:
                return None, 0, 0
            cx, cy, ang = cap_pos(tt)
            if cy + ch < -40:
                return None, 0, 0
            im = cimg.rotate(-ang * 1.6, expand=True, resample=Image.BICUBIC)
            px, py, _ = cap_pos(tt - FRAME_S)
            return smear(im, cx, cy, cx - px, cy - py)
        csp = SmoothSprite(self, sid + '-cap', None, 0, 0, t_pop, 'none', 0, order=e.get('order', 58) + 1, jitter=False)
        csp.dynamic = cap_dyn
        self.add(csp)
        self.sound('cap_pop', t_pop)

    chip_font = kit.sf('display_bold', e.get('chip_px', 30))

    def chip(text):
        tw = int(chip_font.getlength(text))
        im = Image.new('RGBA', (tw + 40, 54), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.rounded_rectangle([0, 0, tw + 39, 53], radius=27, fill=BLACK + (255,))
        d.text((20, 27), text, font=chip_font, fill=WHITE + (255,), anchor='lm')
        return im

    for k, dr in enumerate(drops):  # each wish falls into the open spout under gravity and is swallowed by it
        cimg = chip(dr['text'])
        t_hit = dr['hit']
        y_top = -cimg.height - 20
        drop_h = spout_y - y_top

        def chip_dyn(tt, cimg=cimg, t_hit=t_hit, fall_s=fall_s, y_top=y_top, drop_h=drop_h):
            t0 = t_hit - fall_s
            if tt < t0 or tt >= t_hit + SWALLOW_S:
                return None, 0, 0
            if tt < t_hit:
                # dropped from above the frame: it speeds up, then is caught by the spout's neck and comes to rest on the mouth
                # (smoothstep), so it lands there with its sound and sinks in, rather than vanishing at full speed
                cy = y_top + drop_h * catch((tt - t0) / fall_s)
                im = cimg
                py = y_top + drop_h * catch((tt - FRAME_S - t0) / fall_s)
                cx = spout_x - im.width / 2
                return smear(im, cx, cy - im.height, 0, cy - py)
            # swallowed: the chip pinches narrow in the neck and slows as it slides down through the mouth; only the part still
            # above the mouth is drawn, so it goes in rather than vanishing, and its last frames are a slow thin sliver
            u = ease_out((tt - t_hit) / SWALLOW_S)
            w = max(1, int(cimg.width * (1 - 0.65 * u)))
            im = cimg.resize((w, cimg.height), Image.LANCZOS)
            above = int(round(cimg.height * (1 - u)))
            if above < 1:
                return None, 0, 0
            return im.crop((0, 0, w, above)), spout_x - w / 2, spout_y - above
        csp = SmoothSprite(self, f'{sid}-drop{k}', None, 0, 0, t_hit - fall_s, 'none', 0, order=e.get('order', 58) - 1, jitter=False)
        csp.dynamic = chip_dyn
        self.add(csp)
        self.sound(dr.get('sound', 'plop1'), t_hit)

    if sq:  # a bead of jelly rises out of the spout while the pouch is squeezed, and is drawn back in
        def bead_dyn(tt):
            if not (t_sq <= tt < t_sq + sq_s):
                return None, 0, 0
            p = math.sin(math.pi * (tt - t_sq) / sq_s)
            r = 6 + 16 * p
            im = Image.new('RGBA', (int(2 * r + 8), int(2 * r + 8)), (0, 0, 0, 0))
            d = ImageDraw.Draw(im)
            d.ellipse([4, 4, 4 + 2 * r, 4 + 2 * r], fill=gel + (235,))
            d.ellipse([4 + r * 0.45, 4 + r * 0.3, 4 + r * 0.95, 4 + r * 0.75], fill=(255, 236, 210, 200))  # the wet highlight
            return im, spout_x - im.width / 2, spout_y - im.height * (0.35 + 0.5 * p)
        bsp = SmoothSprite(self, sid + '-bead', None, 0, 0, t_sq, 'none', 0, order=e.get('order', 58) - 1, jitter=False)
        bsp.dynamic = bead_dyn
        self.add(bsp)
        self.sound('squeeze', t_sq)

    def card(lines_at, w, tt, px_default, fade_from=None):
        """A black tag with white type: the shown lines at tt (each line {text, px, bold}); fade_from: the tag fades in over
        0.18 s from then (a tag that appears in place with its first line instead of sliding in)."""
        shown = [dict(ln, text=row) for ln in lines_at if tt >= ln['t'] for row in ln['text'].split('\n')]  # a line may wrap with \n
        fonts = [kit.sf('display_bold' if ln.get('bold') else 'text_semibold', ln.get('px', px_default)) for ln in shown]
        heights = [int(f.size * 1.32) for f in fonts]
        h = 36 + sum(heights) + 6
        im = Image.new('RGBA', (w, max(h, 80)), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.rounded_rectangle([0, 0, w - 1, im.height - 1], radius=22, fill=BLACK + (238,))
        yy = 20
        for ln, f, lh in zip(shown, fonts, heights):
            u = clamp((tt - ln['t']) / 0.18)
            d.text((24, yy + (1 - ease_out(u)) * 8), ln['text'], font=f, fill=WHITE + (int(255 * u),))
            yy += lh
        if fade_from is not None and tt < fade_from + 0.18:
            im.putalpha(im.getchannel('A').point(lambda v: int(v * clamp((tt - fade_from) / 0.18))))
        return stage.shadowed(im, TAG_SHADOW)[0]

    tag = e.get('tag')
    if tag:
        tl = [dict(ln, t=T(ln['at'])) for ln in tag['lines']]
        tx, ty = tag['pos']
        C.slide(self, sid + '-tag', lambda tt: card(tl, tag['w'], tt, tag.get('px', 30)), tx, ty, T(tag['at']), T(tag['out']),
                enter=tag.get('enter', 'right'), exit=tag.get('exit', 'up'), order=e.get('order', 58) + 2)
        self.sound('card_in', T(tag['at']))
        self.sound('card_out', T(tag['out']))

    lst = e.get('list')
    if lst:
        ll = [{'text': '+ ' + dr['text'], 't': dr['t'], 'px': lst.get('px', 34), 'bold': True} for dr in drops]
        lx, ly = lst['pos']
        t_list = T(lst['at'])
        C.slide(self, sid + '-list', lambda tt: card(ll, lst['w'], tt, lst.get('px', 34), fade_from=t_list), lx, ly, t_list, t_out,
                enter='none', exit=lst.get('exit', 'right'), order=e.get('order', 58) + 2)
    self.sound('card_out', t_out)  # everything leaves together: the list slides out, the pouch falls out of the frame
