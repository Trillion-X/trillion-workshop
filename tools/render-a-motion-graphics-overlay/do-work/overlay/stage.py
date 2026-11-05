"""The stage every event draws on: frame size and rate, colours and faces, paper textures and shadows, torn edges, word
times, sprites and how a sprite is drawn, and the coloured-pencil restyle of a real frame.

Imported after look.install(): W, H, FPS and HOLD are read from the settings when this module loads. W and H change when
a spec gives its own canvas (a still slide), so modules read them as stage.W and stage.H, never by value.
Every length in the recipe is in canvas pixels of a 1080-line frame; K is that scale (1.0)."""
import json

import cv2
import numpy as np
from PIL import Image, ImageFilter, ImageFont

from overlay import look

R = look.R
W, H = look.SECTIONS['frame']
K = 1.0
FPS_N, FPS_D = R['frame']['fps_num'], R['frame']['fps_den']
FPS = FPS_N / FPS_D
PAL = R['palette']
HOLD = R['motion']['stop_motion_hold_frames']
PUNCT = '.,?!:;'
P = look.asset


def rgb(name_or_hex):
    h = PAL.get(name_or_hex, name_or_hex)
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def font(spec, size_px, weight=None):
    if look.SECTIONS['faces'] == 'builtin':  # every face is Pillow's own (an example look, or a computer without the faces)
        return ImageFont.load_default(max(1, int(round(size_px))))
    f = ImageFont.truetype(P(spec['file'] if isinstance(spec, dict) else spec), int(round(size_px)))
    w = weight if weight is not None else (spec.get('weight') if isinstance(spec, dict) else None)
    if w is not None:
        try:
            f.set_variation_by_axes([w])
        except OSError:
            pass
    return f


def ease_out(x):
    x = min(max(x, 0.0), 1.0)
    return 1 - (1 - x) ** 3


def ease_in(x):
    x = min(max(x, 0.0), 1.0)
    return x ** 3


def ease_out_back(x, s=1.7):
    x = min(max(x, 0.0), 1.0) - 1
    return 1 + (s + 1) * x ** 3 + s * x ** 2


# ---------- textures ----------
_tex_cache = {}


def texture(name, w, h, seed):
    key = (name, w, h, seed)
    if key in _tex_cache:
        return _tex_cache[key]
    t = cv2.imread(P(R['textures'][name]), cv2.IMREAD_GRAYSCALE).astype(np.float32)
    rng = np.random.default_rng(seed)
    sc = max(w / t.shape[1], h / t.shape[0], 0.6)
    if sc > 1:
        t = cv2.resize(t, None, fx=sc, fy=sc, interpolation=cv2.INTER_LINEAR)
    while t.shape[0] < h or t.shape[1] < w:
        t = np.tile(t, (2, 2))
    y0 = rng.integers(0, t.shape[0] - h + 1); x0 = rng.integers(0, t.shape[1] - w + 1)
    t = t[y0:y0 + h, x0:x0 + w]
    t = t / max(t.mean(), 1.0)
    _tex_cache[key] = t
    return t


def apply_texture(img, name, seed, strength=None):
    s = R['textures']['texture_strength'] if strength is None else strength
    a = np.asarray(img).astype(np.float32)
    t = texture(name, a.shape[1], a.shape[0], seed)
    rng = np.random.default_rng(seed + 99)
    grain = 1 + rng.normal(0, R['textures']['grain_strength'], t.shape)
    m = (1 + (t - 1) * s) * grain
    a[..., :3] = np.clip(a[..., :3] * m[..., None], 0, 255)
    return Image.fromarray(a.astype(np.uint8), 'RGBA')


def shadowed(img, sh):
    """img RGBA -> RGBA with a soft drop shadow (recipe shadow dict in 1080 units)."""
    dx, dy, bl = sh.get('dx', 0) * K, sh.get('dy', 0) * K, sh['blur'] * K
    pad = int(bl * 3 + max(abs(dx), abs(dy)) + 4)
    w, h = img.size
    out = Image.new('RGBA', (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    a = img.getchannel('A')
    shadow = Image.new('RGBA', out.size, (0, 0, 0, 0))
    sa = Image.new('L', out.size, 0)
    sa.paste(a, (int(pad + dx), int(pad + dy)))
    sa = sa.filter(ImageFilter.GaussianBlur(bl)).point(lambda v: int(v * sh['opacity']))
    shadow.putalpha(sa)
    out.alpha_composite(shadow)
    out.alpha_composite(img, (pad, pad))
    return out, pad


def torn_polygon(w, h, amp, seed, step=None):
    rng = np.random.default_rng(seed)
    step = step or max(6, amp * 2.5)
    pts = []
    for x in np.arange(0, w, step):
        pts.append((x, rng.uniform(0, amp)))
    for y in np.arange(0, h, step):
        pts.append((w - rng.uniform(0, amp), y))
    for x in np.arange(w, 0, -step):
        pts.append((x, h - rng.uniform(0, amp)))
    for y in np.arange(h, 0, -step):
        pts.append((rng.uniform(0, amp), y))
    return pts


def paste(canvas, img, x, y, alpha=1.0):
    x, y = int(round(x)), int(round(y))
    w, h = img.size
    x0, y0 = max(x, 0), max(y, 0)
    x1, y1 = min(x + w, W), min(y + h, H)
    if x1 <= x0 or y1 <= y0:
        return
    crop = img.crop((x0 - x, y0 - y, x1 - x, y1 - y))
    if alpha < 0.999:
        crop = crop.copy()
        crop.putalpha(crop.getchannel('A').point(lambda v: int(v * alpha)))
    canvas.alpha_composite(crop, (x0, y0))



# ---------- words ----------
class Words:
    """The voice's word times. Times are seconds, or [word, offset] against them: `word#n` is the n-th time the word is said.
    A spec with no voice has no words, and its times are plain seconds."""

    def __init__(self, voice):
        self.w, self.t0 = [], 0.0
        if voice:
            w = json.load(open(voice['words']))
            self.w = w.get('words', w) if isinstance(w, dict) else w
            self.t0 = voice['start_s']

    def at(self, spec):
        if isinstance(spec, (int, float)):
            return float(spec)
        word, off = spec
        name, _, nth = word.partition('#')
        nth = int(nth or 1)
        hits = [x for x in self.w if x['text'].strip(PUNCT) == name.strip(PUNCT)]
        if len(hits) < nth:
            raise SystemExit(f'word {word!r} not in narration')
        return self.t0 + hits[nth - 1]['start'] + off

    def end(self):
        return self.t0 + (self.w[-1]['end'] if self.w else 0.0)


# ---------- sprites ----------
class Sprite:
    def __init__(self, sid, img, x, y, t_in, intro='pop', intro_s=0.17, order=0, jitter=True):
        self.id, self.img, self.x, self.y, self.t_in = sid, img, x, y, t_in
        self.intro, self.intro_s, self.order, self.jitter = intro, intro_s, order, jitter
        self.moves, self.t_out, self.out_dx, self.out_dy, self.until = [], None, 0, 0, None
        self.dynamic = None  # callable(t) -> (img, x, y) overriding img

    def state(self, t):
        if t < self.t_in or (self.until is not None and t >= self.until + 0.12):
            return None
        img, x, y = (self.dynamic(t) if self.dynamic else (self.img, self.x, self.y))
        if img is None:
            return None
        scale, alpha = 1.0, 1.0
        u = (t - self.t_in) / self.intro_s if self.intro_s else 1
        if self.intro == 'pop':
            scale = R['cutout']['pop_scale_from'] + (1 - R['cutout']['pop_scale_from']) * ease_out_back(u)
            alpha = min(1.0, u * 2.5)
        elif self.intro == 'slam':
            scale = R['card']['slam_from_scale'] + (1 - R['card']['slam_from_scale']) * ease_out(u)
            alpha = min(1.0, u * 3)
        elif self.intro == 'fade':
            alpha = min(1.0, u)
        if self.until is not None and t > self.until:
            alpha *= max(0.0, 1 - (t - self.until) / 0.12)
        dx = dy = 0.0
        for m in self.moves:
            v = ease_out((t - m['t']) / m['dur']) if t > m['t'] else 0.0
            dx += m['dx'] * K * v; dy += m['dy'] * K * v
            scale *= 1 + (m.get('scale', 1.0) - 1) * v
        if self.t_out is not None and t > self.t_out:
            v = ease_in((t - self.t_out) / 0.28)
            dx += self.out_dx * K * v; dy += self.out_dy * K * v
            if v >= 1:
                return None
        return img, x + dx, y + dy, scale, alpha


def render_sprite(canvas, st, jit):
    img, x, y, scale, alpha = st
    if abs(scale - 1) > 1e-3:
        w, h = img.size
        nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
        img2 = img.resize((nw, nh), Image.BILINEAR)
        x, y = x + (w - nw) / 2, y + (h - nh) / 2
        img = img2
    paste(canvas, img, x + jit[0], y + jit[1], alpha)


# ---------- coloured-pencil restyle of a real frame (no generation): dodge-blend lines, smoothed colour, hatching, paper grain ----------
def hatch_texture(h, w, density, length, angle_deg, seed):
    rng = np.random.default_rng(seed)
    tex = np.full((h, w), 255, np.uint8)
    n = int(h * w * density / (length * length))
    a = np.deg2rad(angle_deg)
    dx, dy = np.cos(a) * length / 2, np.sin(a) * length / 2
    xs = rng.uniform(0, w, n); ys = rng.uniform(0, h, n); vs = rng.integers(150, 225, n)
    for x, y, v in zip(xs, ys, vs):
        j = rng.normal(0, 0.12)
        cv2.line(tex, (int(x - dx), int(y - dy * (1 + j))), (int(x + dx), int(y + dy * (1 - j))), int(v), 1, cv2.LINE_AA)
    return cv2.GaussianBlur(tex, (0, 0), 0.6).astype(np.float32) / 255.0


def pencil(rgb, p, seed=7):
    """rgb uint8 HxWx3 -> uint8 HxWx3. p = recipe['cutout']['pencil']."""
    h, w = rgb.shape[:2]
    f = rgb.astype(np.float32) / 255.0
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    inv_blur = cv2.GaussianBlur(1.0 - gray, (0, 0), p['line_blur_px'])
    dodge = np.clip(gray / np.maximum(1.0 - inv_blur, 1e-3), 0, 1)
    lines = dodge ** p['line_gamma']
    col = cv2.edgePreservingFilter(rgb, flags=1, sigma_s=p['smooth_sigma_s'], sigma_r=p['smooth_sigma_r']).astype(np.float32) / 255.0
    hsv = cv2.cvtColor((col * 255).astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
    hsv[..., 1] = np.clip(hsv[..., 1] * p['saturation'], 0, 255)
    col = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2RGB).astype(np.float32) / 255.0
    dark = 1.0 - cv2.GaussianBlur(gray, (0, 0), 3)
    h1 = hatch_texture(h, w, p['hatch_density'], p['hatch_len_px'], p['hatch_angle_deg'], seed)
    h2 = hatch_texture(h, w, p['hatch_density'] * 0.6, p['hatch_len_px'], p['hatch_angle_deg'] + 75, seed + 1)
    hatch = 1.0 - (1.0 - h1) * (0.4 + dark) - (1.0 - h2) * np.clip(dark - 0.35, 0, 1) * 1.6
    hatch = np.clip(hatch, 0, 1)[..., None] ** p['hatch_strength']
    light = cv2.GaussianBlur(gray, (0, 0), 2)[..., None]
    paper = np.array(p['paper_rgb'], np.float32)[None, None] / 255.0
    gaps = (hatch > 0.97) * np.clip((light - 0.72) * p['paper_show'], 0, 1)
    shaded = col * (p['line_mix'] * lines + (1 - p['line_mix']))[..., None] * hatch
    shaded = shaded * (1 - gaps) + paper * gaps
    out = shaded * (1 - p['detail_keep']) + f * p['detail_keep']
    return (np.clip(out, 0, 1) * 255).astype(np.uint8)
