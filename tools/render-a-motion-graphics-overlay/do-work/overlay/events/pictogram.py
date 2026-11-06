"""pictogram (lane ch3): an amount shown as that many real-world things, one icon per unit, each landing on the beat it is
counted, then one paper caption that says what the pile means with its source (technique: isotype pictogram, Otto
Neurath's "count the things, not the bars"; filmcraft/options-ch3/TECHNIQUES.md#pictogram-count). Layout as data: a row, or a stack
that grows upward like a pile.

    {"type": "pictogram", "id": "beef", "icon": "parcel" | "banana", "icon_w": 150,
     "slots": [[x, y], ...], "at": s, "every_s": 0.22,          icon k lands at at + k * every_s, dropping into its slot
     "rots": [deg, ...],
     "caption": {"text": "...", "source": "...", "pos": [x, y], "w": 520, "at": s},
     "sounds": ["thump"],                                         one per landing, cycled
     "out": s, "exit": "fall"}                                   each icon falls out of frame, staggered

Icons are drawn here: "parcel" is a butcher-paper pound of meat tied with string and marked "1 lb"; "banana" a ripe
banana with brown tips. Caption: ink on white paper (synthetic-4b111b631333)."""
import math
import os
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from overlay.helpers import paper_pieces as K


def _parcel(w, seed):
    h = int(w * 0.62)
    im = K.paper(w, h, 'kraft', seed, edge='torn')
    d = ImageDraw.Draw(im)
    twine = (236, 228, 210, 255)
    d.line([(w * 0.5, 0), (w * 0.52, h)], fill=twine, width=4)
    d.line([(0, h * 0.48), (w, h * 0.52)], fill=twine, width=4)
    d.ellipse([w * 0.5 - 9, h * 0.5 - 7, w * 0.5 + 9, h * 0.5 + 7], outline=twine, width=3)
    lab = K.hand('1 lb beef', 'PermanentMarker-Regular.ttf', int(h * 0.24))
    im.alpha_composite(lab, (int(w * 0.08), int(h * 0.08)))
    return im


def _banana(w, seed):
    h = int(w * 0.42)
    rng = np.random.default_rng(seed)
    S = 3  # supersample
    W, H = w * S, h * S
    m = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(m)
    pts_o, pts_i = [], []
    for k in range(61):
        u = k / 60
        x = W * (0.04 + 0.92 * u)
        yo = H * (0.18 + 0.62 * (2 * u - 1) ** 2)            # outer (lower) curve
        th = H * 0.42 * math.sin(math.pi * min(1.0, 0.08 + 0.9 * u)) ** 0.6
        pts_o.append((x, yo + th * 0.5))
        pts_i.append((x, yo - th * 0.5))
    d.polygon(pts_i + pts_o[::-1], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(S * 0.8)).resize((w, h), Image.LANCZOS)
    a = np.asarray(m).astype(np.float32) / 255
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    base = np.array([238, 196, 52], np.float32)
    shade = 0.78 + 0.28 * np.clip(1 - (yy / h), 0, 1)        # lighter towards the top edge
    rgb = base[None, None] * shade[..., None]
    for _ in range(18):  # ripe speckles
        cx, cy = rng.uniform(0.15, 0.85) * w, rng.uniform(0.3, 0.7) * h
        r2 = ((xx - cx) ** 2 + (yy - cy) ** 2) / (rng.uniform(0.8, 2.2) ** 2)
        rgb = rgb * (1 - 0.55 * np.exp(-r2)[..., None]) + np.array([92, 58, 20], np.float32) * 0.55 * np.exp(-r2)[..., None]
    tip = np.clip(1 - np.minimum(xx, w - xx) / (w * 0.07), 0, 1)  # brown stem and tip
    rgb = rgb * (1 - tip[..., None]) + np.array([70, 48, 22], np.float32) * tip[..., None]
    im = Image.fromarray(np.dstack([np.clip(rgb, 0, 255), a * 255]).astype(np.uint8), 'RGBA')
    return im


ICONS = {'parcel': _parcel, 'banana': _banana}


def _caption(e, seed):
    c = e['caption']
    body = K.hand(c['text'], c.get('face', 'Kalam-Bold.ttf'), c.get('size', 40))
    src = K.hand(c['source'], 'SpecialElite-Regular.ttf', c.get('source_px', 20)) if c.get('source') else None
    pad = 26
    w = max(body.width, src.width if src else 0) + 2 * pad
    h = body.height + (src.height + 6 if src else 0) + 2 * pad
    p = K.paper(w, h, 'white', seed, edge='torn')
    p.alpha_composite(body, (pad, pad))
    if src:
        p.alpha_composite(src, (pad, pad + body.height + 6))
    return K.shadow(p.rotate(-c.get('rot', 0), expand=True, resample=K.Image.BICUBIC))[0]


def ev_pictogram(self, e):
    sid = e.get('id', 'pict')
    t0, every, t_out = self.T(e['at']), e.get('every_s', 0.22), self.T(e['out'])
    rots = e.get('rots', [0])
    for k, (x, y) in enumerate(e['slots']):
        self.seed += 1
        icon = ICONS[e['icon']](e.get('icon_w', 150), self.seed)
        icon = K.shadow(icon.rotate(-rots[k % len(rots)], expand=True, resample=Image.BICUBIC), soft=True)[0]
        tk = t0 + k * every
        K.moving(self, f'{sid}-{k}', lambda tt, im=icon: im, x, y, tk, t_out + k * e.get('out_every_s', 0.05), enter=e.get('enter', 'top'),
                 exit=e.get('exit', 'fall'), enter_s=0.22, order=60 + k, drift=False)
        sounds = e.get('sounds', ['thump'])
        self.sound(sounds[k % len(sounds)], tk + 0.2)  # on the landing, not the start of the drop
    if e.get('caption'):
        self.seed += 1
        cap = _caption(e, self.seed)
        tc = self.T(e['caption']['at'])
        x, y = e['caption']['pos']
        K.moving(self, f'{sid}-cap', lambda tt: cap, x, y, tc, t_out, enter=e['caption'].get('enter', 'right'), exit=e['caption'].get('exit', 'right'), order=75)
        self.sound('slide_in', tc)
        self.sound('slide_out', t_out)
