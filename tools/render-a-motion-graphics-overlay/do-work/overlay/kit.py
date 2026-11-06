"""Helpers events share beyond the stage: look colours and faces, type with the soft wide shadow, footage frames (decoded
at the stop-motion rate, or read at the film's own rate through one pipe), crop-to-fill, the red textured brush stroke,
scrapbook edges, exit directions as compass words, sprites drawn at the exact frame time, and how torn halves leave.

Imported after look.install(), like stage."""
import math
import os
import subprocess

import numpy as np
from PIL import Image, ImageDraw

from overlay import look, stage

SAFE = look.LOOK3['safe_margin_px']
ease_out, ease_in = stage.ease_out, stage.ease_in


def col(name):
    h = look.LOOK['colour'].get(name, name).lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def sf(kind, size):
    return stage.font(look.LOOK['fonts'][kind], size)



def text_img(text, fnt, colour, shadow=True, pad=6, align='left', leading=1.12):
    lines = text.split('\n')
    asc, desc = fnt.getmetrics()
    lh = int((asc + desc) * leading)
    w = int(max(fnt.getlength(l) for l in lines)) + 2 * pad
    h = lh * len(lines) + 2 * pad
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for i, l in enumerate(lines):
        x = pad if align == 'left' else (w - fnt.getlength(l)) / 2
        d.text((x, pad + i * lh), l, font=fnt, fill=colour + (255,))
    if shadow:
        im, p = stage.shadowed(im, look.LOOK['text_shadow'])
        return im, p
    return im, 0


def clip_frames(src, start, dur, speed=1.0, size=None, crop=None, hlg=None, fps=None):
    """Decode a clip to a list of RGB PIL frames at the overlay's stop-motion rate (one per HOLD frames)."""
    fps = fps or stage.FPS / stage.HOLD
    if hlg is None:
        pr = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer', '-of', 'csv=p=0', src],
                            capture_output=True, text=True).stdout.strip()
        hlg = pr.startswith('arib') or pr.startswith('smpte2084')
    vf = []
    if hlg:
        vf.append('zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p')
    vf.append(f'setpts=PTS/{speed}')
    vf.append(f'fps={fps:.6f}')
    if crop:
        vf.append(f'crop={crop[2] - crop[0]}:{crop[3] - crop[1]}:{crop[0]}:{crop[1]}')
    if size:
        vf.append(f'scale={size[0]}:{size[1]}:flags=lanczos')
    vf.append('format=rgb24')
    import tempfile
    with tempfile.TemporaryDirectory(prefix='overlay-clip-') as td:
        cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-ss', f'{start:.3f}', '-t', f'{dur * speed:.3f}', '-i', src, '-an', '-vf', ','.join(vf),
               os.path.join(td, '%05d.png')]
        subprocess.run(cmd, check=True)
        return [Image.open(os.path.join(td, f)).convert('RGB') for f in sorted(os.listdir(td))]


def cover(im, w, h, focus=(0.5, 0.5)):
    """Crop-to-fill im into w x h around a focus point (fractions)."""
    sc = max(w / im.width, h / im.height)
    nw, nh = int(math.ceil(im.width * sc)), int(math.ceil(im.height * sc))
    im = im.resize((nw, nh), Image.LANCZOS)
    x0 = int(min(max(focus[0] * nw - w / 2, 0), nw - w))
    y0 = int(min(max(focus[1] * nh - h / 2, 0), nh - h))
    return im.crop((x0, y0, x0 + w, y0 + h))


def brush_stroke(length, height, seed, colour):
    """One textured-brush stroke, RGBA, drawn left to right: ragged ends, bristle streaks, dry-brush gaps."""
    rng = np.random.default_rng(seed)
    L, Hh = int(length), int(height)
    pad = int(Hh * 0.6)
    W2, H2 = L + 2 * pad, Hh + 2 * pad
    a = np.zeros((H2, W2), np.float32)
    xs = np.arange(W2)
    # centre line wobble and thickness taper
    cy = H2 / 2 + np.cumsum(rng.normal(0, 0.25, W2)) * 0.6
    cy = cy - np.linspace(0, cy[-1] - H2 / 2, W2) + np.sin(xs / W2 * math.pi) * -Hh * 0.08
    u = np.clip((xs - pad) / max(L, 1), 0, 1)
    thick = Hh * (0.55 + 0.45 * np.sin(np.clip(u * 1.15, 0, 1) * math.pi) ** 0.35) * (1 + rng.normal(0, 0.03, W2))
    yy = np.arange(H2)[:, None]
    dist = np.abs(yy - cy[None, :]) / (thick[None, :] / 2)
    a = np.clip(1.25 - dist, 0, 1)
    a[:, :pad] *= np.clip((xs[:pad] - pad * 0.3) / (pad * 0.7), 0, 1)[None, :] ** 0.6
    a[:, -pad:] *= np.clip((W2 - xs[-pad:] - pad * 0.2) / (pad * 0.8), 0, 1)[None, :] ** 0.8
    # bristle streaks: noise constant along x, smoothed
    streak = rng.uniform(0.55, 1.0, (H2, 1)).astype(np.float32)
    streak = np.repeat(streak, W2, 1)
    import cv2
    streak = cv2.GaussianBlur(streak, (0, 0), sigmaX=6, sigmaY=0.8)
    dry = (rng.uniform(0, 1, (H2, W2)) > (0.05 + 0.5 * u[None, :] ** 3)).astype(np.float32)
    dry = cv2.GaussianBlur(dry, (0, 0), sigmaX=3, sigmaY=0.6)
    a = a * (0.35 + 0.65 * streak) * (0.55 + 0.45 * dry)
    a = np.clip(a * 1.35, 0, 1)
    rgb = np.zeros((H2, W2, 3), np.float32)
    c = np.array(colour, np.float32)
    shade = 0.85 + 0.15 * streak[..., None]
    rgb[:] = c[None, None] * shade
    im = np.dstack([np.clip(rgb, 0, 255), a * 255]).astype(np.uint8)
    return Image.fromarray(im, 'RGBA'), pad



def face(name, size):
    """A face by file name in the faces folder, or a font role of the look (display_bold, ...)."""
    if name in look.LOOK['fonts']:
        return sf(name, size)
    return stage.font(os.path.join(look.FOLDERS['faces'], name), size)


def compass(d):
    """'N', 'NE', ... or [dx, dy] -> a vector long enough to leave the frame from anywhere."""
    if isinstance(d, (list, tuple)):
        return float(d[0]), float(d[1])
    v = look.LOOK3['compass'][d]
    return v[0] * look.LOOK3['exit_distance_px'], v[1] * look.LOOK3['exit_distance_px']


# ---------------------------------------------------------------- scrapbook edges
def edge_mask(w, h, style, seed, amp=None):
    """L mask of a w x h piece with a scrapbook edge. Styles (look3 edges): deckle (fine tear), jagged (big tear),
    pinking (zig-zag of pinking shears), wavy (sine), scallop (half circles), stamp (postage-stamp perforation),
    clipped (corners cut off at different angles), straight."""
    rng = np.random.default_rng(seed)
    E = look.LOOK3['edges'][style]
    amp = E.get('amp', 0) if amp is None else amp
    m = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(m)
    if style in ('deckle', 'jagged'):
        d.polygon(stage.torn_polygon(w, h, amp, seed, step=E['step']), fill=255)
    elif style in ('pinking', 'wavy', 'scallop'):
        per = E['period']
        pts = []

        def off(s):
            u = (s % per) / per
            if style == 'pinking':
                return amp * (1 - abs(2 * u - 1))
            if style == 'wavy':
                return amp * (0.5 + 0.5 * math.sin(2 * math.pi * u))
            return amp * (1 - math.sqrt(max(0.0, 1 - (2 * u - 1) ** 2)))
        n = lambda L: max(2, int(L / (per / 8)))
        for x in np.linspace(0, w, n(w)):
            pts.append((x, off(x)))
        for y in np.linspace(0, h, n(h)):
            pts.append((w - off(y + w), y))
        for x in np.linspace(w, 0, n(w)):
            pts.append((x, h - off(x + w + h)))
        for y in np.linspace(h, 0, n(h)):
            pts.append((off(y), y))
        d.polygon(pts, fill=255)
    elif style == 'stamp':
        d.rectangle([0, 0, w, h], fill=255)
        r, per = E['hole_r'], E['period']
        for x in np.arange(per / 2, w, per):
            d.ellipse([x - r, -r, x + r, r], fill=0)
            d.ellipse([x - r, h - r, x + r, h + r], fill=0)
        for y in np.arange(per / 2, h, per):
            d.ellipse([-r, y - r, r, y + r], fill=0)
            d.ellipse([w - r, y - r, w + r, y + r], fill=0)
    elif style == 'clipped':
        c = [rng.uniform(*E['cut_px']) for _ in range(8)]
        d.polygon([(c[0], 0), (w - c[1], 0), (w, c[2]), (w, h - c[3]), (w - c[4], h), (c[5], h), (0, h - c[6]), (0, c[7])], fill=255)
    else:
        d.rectangle([0, 0, w, h], fill=255)
    return m


class SmoothSprite(stage.Sprite):
    """A sprite that is drawn at the frame's exact time instead of the stop-motion step (footage, count-ups)."""

    def __init__(self, b, *a, **k):
        super().__init__(*a, **k)
        self.b = b

    def state(self, t):
        return super().state(self.b.t_exact)


class ClipReader:
    """Frames of a clip at the film's frame rate, read in order from one ffmpeg pipe (HLG tone-mapped like clip_frames)."""

    def __init__(self, src, start, size, crop=None, speed=1.0):
        self.src, self.start, self.size, self.crop, self.speed = src, start, size, crop, speed
        self.p, self.i, self.last = None, -1, None

    def _open(self):
        pr = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer', '-of', 'csv=p=0', self.src],
                            capture_output=True, text=True).stdout.strip()
        vf = []
        if pr.startswith('arib') or pr.startswith('smpte2084'):
            vf.append('zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p')
        vf.append(f'setpts=PTS/{self.speed}')
        vf.append(f'fps={stage.FPS_N}/{stage.FPS_D}')
        if self.crop:
            c = self.crop
            vf.append(f'crop={c[2] - c[0]}:{c[3] - c[1]}:{c[0]}:{c[1]}')
        w, h = self.size
        vf.append(f'scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h}')
        vf.append('format=rgb24')
        if self.p:
            self.p.kill()
        self.p = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-ss', f'{self.start:.3f}', '-i', self.src, '-an', '-vf', ','.join(vf),
                                   '-f', 'rawvideo', '-'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.i = -1

    def get(self, i):
        w, h = self.size
        if self.p is None or i < self.i:
            self._open()
        while self.i < i:
            buf = self.p.stdout.read(w * h * 3)
            if len(buf) < w * h * 3:
                break
            self.last = Image.frombytes('RGB', (w, h), buf)
            self.i += 1
        return self.last


TEAR_PARTS = {  # how the torn halves and everything on them leave (tear_exit e.part)
    'fall': {'s': 0.42, 'half_dx': 420, 'half_dy': 1150, 'dx': 260, 'dy': 1150},   # halves drop out of the bottom
    'side': {'s': 0.42, 'half_dx': 1200, 'half_dy': 160, 'dx': 1300, 'dy': 120},   # halves part sideways from the tear line
}


def tear_part(e):
    return TEAR_PARTS[e.get('part', 'fall')]

