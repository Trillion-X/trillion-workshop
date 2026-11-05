"""gauge_settle (lane ch2): a row of dials, one per named quantity, each landing on its word with its needle still searching
around its mark; on the settle word every needle swings onto its mark with a damped spring (small overshoot, then still),
one after another, a click as each locks (technique: gauge needle with spring settle; filmcraft/options-ch2/techniques/gauge-settle.md).
Line-art dials in white over footage with the soft wide shadow; labels in SF Pro under each dial; every frame drawn.

    {"type": "gauge_settle", "id": "dials", "r": 92, "settle_at": s, "settle_stagger_s": 0.12, "out": s, "out_dir": "W",
     "dials": [{"label": "nutrients", "center": [x, y], "at": s, "target_deg": 20}]}   0 deg = straight up, + = clockwise
"""
import math
from PIL import Image, ImageDraw
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, compass, ease_in, ease_out
from overlay.helpers.motion_smear import smeared
SPAN = 120  # the scale runs from -SPAN to +SPAN degrees


def _needle_deg(tt, t_in, t_set, target, phase):
    """Searching before the settle (a slow sway 35-60 deg off the mark), then a damped spring onto the mark."""
    def search(t):
        return target + 48 * math.sin(1.7 * (t - t_in) + phase) + 12 * math.sin(3.1 * (t - t_in) + 2 * phase)
    if tt < t_set:
        return max(-SPAN, min(SPAN, search(tt)))
    d0 = max(-SPAN, min(SPAN, search(t_set))) - target
    u = tt - t_set
    return target + d0 * math.exp(-7.0 * u) * math.cos(11.0 * u)


def _dial(r, label_im, deg, target, scale):
    S = 2  # drawn at 2x, then reduced, for smooth lines
    R = int(r * S)
    W = 2 * R + 40 * S
    im = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = W / 2
    d.arc([c - R, c - R, c + R, c + R], start=-90 - SPAN - 6, end=-90 + SPAN + 6, fill=(255, 255, 255, 255), width=5 * S)
    for a in range(-SPAN, SPAN + 1, 30):
        rad = math.radians(a - 90)
        r0 = R - (16 if a % 60 == 0 else 10) * S
        d.line([(c + r0 * math.cos(rad), c + r0 * math.sin(rad)), (c + (R - 3 * S) * math.cos(rad), c + (R - 3 * S) * math.sin(rad))],
               fill=(255, 255, 255, 255), width=3 * S)
    rad = math.radians(target - 90)  # the mark: a small triangle just outside the rim
    tip = (c + (R + 4 * S) * math.cos(rad), c + (R + 4 * S) * math.sin(rad))
    perp = (-math.sin(rad), math.cos(rad))
    base = (c + (R + 22 * S) * math.cos(rad), c + (R + 22 * S) * math.sin(rad))
    d.polygon([tip, (base[0] + perp[0] * 9 * S, base[1] + perp[1] * 9 * S), (base[0] - perp[0] * 9 * S, base[1] - perp[1] * 9 * S)],
              fill=(255, 255, 255, 255))
    rad = math.radians(deg - 90)
    d.line([(c, c), (c + (R - 22 * S) * math.cos(rad), c + (R - 22 * S) * math.sin(rad))], fill=(255, 255, 255, 255), width=6 * S)
    d.ellipse([c - 10 * S, c - 10 * S, c + 10 * S, c + 10 * S], fill=(255, 255, 255, 255))
    im = im.resize((W // S, W // S), Image.LANCZOS)
    out = Image.new('RGBA', (im.width + 20, im.height + label_im.height + 10), (0, 0, 0, 0))
    out.alpha_composite(im, (10, 0))
    out.alpha_composite(label_im, ((out.width - label_im.width) // 2, im.height - 22))
    if abs(scale - 1) > 1e-3:
        out = out.resize((max(1, int(out.width * scale)), max(1, int(out.height * scale))), Image.BILINEAR)
    return stage.shadowed(out, look.LOOK['text_shadow'])


def ev_gauge_settle(self, e):
    sid = e.get('id', 'dials')
    r = e.get('r', 92)
    t_set0, t_out = self.T(e['settle_at']), self.T(e['out'])
    ox, oy = compass(e.get('out_dir', 'W'))
    fnt = kit.sf('display_semibold', e.get('label_size', 36))

    def leave(tt):
        v = ease_in((tt - t_out) / 0.45) if tt >= t_out else 0.0
        return (None, None) if v >= 1 else (ox * v, oy * v)
    for k, dl in enumerate(e['dials']):
        lab, _ = kit.text_img(dl['label'], fnt, kit.col('white'), shadow=False)
        t_in = self.T(dl['at'])
        t_set = t_set0 + k * e.get('settle_stagger_s', 0.12)
        cx, cy = dl['center']
        target = dl['target_deg']
        probe, ppad = _dial(r, lab, 0, target, 1.0)
        self.safe_box(f'{sid}{k}', *self.opaque_box(probe, cx - probe.width / 2, cy - r - 20 - ppad), t_in, t_out)

        def dyn(tt, t_in=t_in, t_set=t_set, target=target, cx=cx, cy=cy, lab=lab, k=k):
            if tt < t_in:
                return None, 0, 0
            v = ease_in((tt - t_out) / 0.45) if tt >= t_out else 0.0
            if v >= 1:
                return None, 0, 0
            u = min(1.0, (tt - t_in) / 0.2)
            sc = 0.86 + 0.14 * ease_out(u)
            img, p = _dial(r, lab, _needle_deg(tt, t_in, t_set, target, 1.3 * k + 0.4), target, sc)
            if u < 1:
                img.putalpha(img.getchannel('A').point(lambda a: int(a * u)))
            top = cy - r * sc - 20 * sc
            return img, cx - img.width / 2 + ox * v, top - p + oy * v
        sp = SmoothSprite(self, f'{sid}{k}', None, 0, 0, t_in, 'none', 0, order=60, jitter=False)
        sp.dynamic = smeared(dyn, leave)
        self.add(sp)
        self.sound('word_in', t_in)
        self.sound('tick', t_set + 0.12)
    self.sound('slide_out', t_out)
