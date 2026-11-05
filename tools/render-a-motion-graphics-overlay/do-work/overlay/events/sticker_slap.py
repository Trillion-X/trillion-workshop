"""sticker_slap (lane ch2): real objects from his own photos as die-cut stickers (the object's own cut-out, a white sticker
border that follows its outline, a soft shadow) slapped down on the frame one per beat, then peeled off and flicked out of
frame (technique: sticker bomb, 21st.dev block sticker-bomb-slap; filmcraft/options-ch2/techniques/sticker-slap.md).

A slap drops from 1.25x to 1x in 0.16 s with a small settle; the peel lifts the sticker (it grows 6% and turns) and it flies
out in its own direction, eased in. Every frame is drawn (no stepping).

    {"type": "sticker_slap", "id": "pills", "border_px": 14, "peel_at": s, "peel_stagger_s": 0.08,
     "stickers": [{"image": "bottle.png" (RGBA cut-out), "center": [x, y], "h": 400, "rot": -6, "at": s, "out": "NE"}]}
"""
import numpy as np
from PIL import Image
import cv2
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, compass, ease_in, ease_out
from overlay.helpers.sound_classes import play


def _sticker(path, h, border):
    im = Image.open(path).convert('RGBA')
    im = im.resize((max(1, int(im.width * h / im.height)), h), Image.LANCZOS)
    pad = border + 4
    a = np.zeros((im.height + 2 * pad, im.width + 2 * pad), np.uint8)
    a[pad:pad + im.height, pad:pad + im.width] = (np.asarray(im.getchannel('A')) > 128).astype(np.uint8) * 255
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * border + 1, 2 * border + 1))
    outline = cv2.dilate(a, k)
    outline = cv2.GaussianBlur(outline, (0, 0), 1.2)
    st = Image.new('RGBA', (a.shape[1], a.shape[0]), (250, 250, 247, 0))
    st.putalpha(Image.fromarray(outline))
    st.alpha_composite(im, (pad, pad))
    return st


def ev_sticker_slap(self, e):
    sid = e.get('id', 'sticker')
    t_peel = self.T(e['peel_at'])
    for k, s in enumerate(e['stickers']):
        base = _sticker(s['image'], s['h'], e.get('border_px', 14))
        rot = s.get('rot', 0)
        flat = base.rotate(-rot, expand=True, resample=Image.BICUBIC)
        img, pad = stage.shadowed(flat, {'dx': 3, 'dy': 8, 'blur': 12, 'opacity': 0.38})
        cx, cy = s['center']
        t_in = self.T(s['at'])
        t_out = t_peel + k * e.get('peel_stagger_s', 0.08)
        ox, oy = compass(s.get('out', 'N'))
        ow, oh = flat.width, flat.height
        self.safe_box(f'{sid}{k}', cx - ow / 2, cy - oh / 2, cx + ow / 2, cy + oh / 2, t_in, t_out)
        lifted = {}

        def dyn(tt, img=img, cx=cx, cy=cy, t_in=t_in, t_out=t_out, ox=ox, oy=oy, base=base, rot=rot, lifted=lifted):
            if tt < t_in:
                return None, 0, 0
            if tt < t_out:
                u = min(1.0, (tt - t_in) / 0.16)
                sc = 1.25 - 0.25 * ease_out(u)
                if u >= 1:  # a small settle after the hit
                    v = (tt - t_in - 0.16) / 0.12
                    sc = 1.0 + (0.025 * np.sin(np.pi * v) if v < 1 else 0.0)
                im = img if abs(sc - 1) < 1e-3 else img.resize((int(img.width * sc), int(img.height * sc)), Image.BILINEAR)
                return im, cx - im.width / 2, cy - im.height / 2
            v = ease_in((tt - t_out) / 0.42)
            if v >= 1:
                return None, 0, 0
            if 'img' not in lifted:  # the peeled sticker: lifted a little, turned, deeper shadow
                lf = base.rotate(-(rot + (14 if ox >= 0 else -14)), expand=True, resample=Image.BICUBIC)
                lf = lf.resize((int(lf.width * 1.06), int(lf.height * 1.06)), Image.BILINEAR)
                lifted['img'] = stage.shadowed(lf, {'dx': 6, 'dy': 18, 'blur': 18, 'opacity': 0.32})[0]
            im = lifted['img']
            return im, cx - im.width / 2 + ox * v, cy - im.height / 2 + oy * v

        sp = SmoothSprite(self, f'{sid}{k}', None, 0, 0, t_in, 'none', 0, order=66 + k, jitter=False)
        sp.dynamic = dyn
        self.add(sp)
        self.sound('paper', t_in)
        play(self, 'ch2_out', t_out)
