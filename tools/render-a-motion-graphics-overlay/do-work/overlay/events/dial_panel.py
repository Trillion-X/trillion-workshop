"""dial_panel (lane ch2, round 2): the person's picked 6:09 dials (c2m09-r1-1, gauge_settle) taken to instrument grade. A dark
glass panel slides in carrying one precision dial per named quantity. Each dial wakes on its word with an ignition self-
test (the needle sweeps the whole scale and back, the ticks it passes light up and fade), then hunts around its mark; on
the settle word every needle springs onto its mark one after another, its coloured arc locks, a ring pulses out from the
hub and a lamp under the label lights, with a knock as each locks. The panel slides out on the exit word.

Techniques: needle-sweep self-test and wave-staggered dials (video-shotcraft gauge-readout-moves); uncertainty needle
(gongnyang #303); activity-ring colour arcs (Apple Watch); damped-spring needle (round 1, gauge_settle); needle ghost
trail as motion blur (Melvynx scene-library gauge); panel moves with motion blur (_ch2_motion). Sounds: _ch2_sound.
filmcraft/options-ch2/techniques/dial-panel.md.

    {"type": "dial_panel", "id": "dials", "panel": [x0, y0, x1, y1], "in_at": s, "settle_at": s, "settle_stagger_s": 0.14,
     "out": s, "out_dir": "E", "r": 68, "label_size": 34,
     "dials": [{"label": "nutrients", "at": s, "target_deg": 40, "colour": [r, g, b]}]}   0 deg = straight up, + clockwise
"""
import math
import numpy as np
from PIL import Image, ImageDraw
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, compass, ease_in, ease_out
from overlay.helpers.motion_smear import FRAME_S, smear
from overlay.helpers.sound_classes import play
SPAN = 135  # the scale runs from -SPAN to +SPAN degrees
S = 2       # drawn at 2x and reduced


def _needle(tt, t_on, t_set, target, phase):
    """Degrees: off until t_on; self-test sweep to the top of the scale and back to the bottom (0.75 s); then a hunt
    among positions around the mark (eased hops, not a wobble); from t_set a damped spring onto the mark."""
    if tt < t_on:
        return -SPAN
    u = tt - t_on
    if u < 0.75:
        return -SPAN + 2 * SPAN * math.sin(math.pi * u / 0.75)

    def hunt(t):
        hop = 0.42
        i = math.floor((t - t_on - 0.75) / hop)
        f = ((t - t_on - 0.75) / hop) - i

        def p(j):
            if j < 0:
                return -SPAN
            return target + 34 * math.sin(2.3 * j + phase) + 14 * math.sin(5.1 * j + 2 * phase)
        f = f * f * (3 - 2 * f)
        return p(i - 1) + (p(i) - p(i - 1)) * f
    if tt < t_set:
        return max(-SPAN, min(SPAN, hunt(tt)))
    d0 = max(-SPAN, min(SPAN, hunt(t_set))) - target
    v = tt - t_set
    return target + d0 * math.exp(-6.5 * v) * math.cos(10.5 * v)


def _pol(c, r, deg):
    a = math.radians(deg - 90)
    return c[0] + r * math.cos(a), c[1] + r * math.sin(a)


def _dial_img(r, colour, deg, lit, locked, power):
    """One dial face, RGBA, centred in a (2r + 60) square. lit[k] in [0, 1] per tick; locked in [0, 1]."""
    R = r * S
    side = int(2 * R + 60 * S)
    im = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = (side / 2, side / 2)
    col = tuple(int(v) for v in colour)
    # bezel and face
    d.ellipse([c[0] - R - 6 * S, c[1] - R - 6 * S, c[0] + R + 6 * S, c[1] + R + 6 * S], fill=(255, 255, 255, int(28 * power)))
    d.ellipse([c[0] - R - 4 * S, c[1] - R - 4 * S, c[0] + R + 4 * S, c[1] + R + 4 * S], fill=(9, 11, 14, int(235 * power)))
    # track and value arc (Apple-ring colour), brighter once locked
    tw = 7 * S
    d.arc([c[0] - R + 9 * S, c[1] - R + 9 * S, c[0] + R - 9 * S, c[1] + R - 9 * S], -90 - SPAN, -90 + SPAN,
          fill=(255, 255, 255, int(30 * power)), width=tw)
    if deg > -SPAN + 0.5:
        a = int((150 + 105 * locked) * power)
        d.arc([c[0] - R + 9 * S, c[1] - R + 9 * S, c[0] + R - 9 * S, c[1] + R - 9 * S], -90 - SPAN, -90 + deg,
              fill=col + (a,), width=tw)
    # ticks: minor every 9 deg, major every 45; lit ones glow white
    for k, a_ in enumerate(range(-SPAN, SPAN + 1, 9)):
        major = (a_ + SPAN) % 45 == 0
        r0 = R - (24 if major else 19) * S
        r1 = R - 14 * S
        al = int((70 + 185 * lit[k]) * power)
        d.line([_pol(c, r0, a_), _pol(c, r1, a_)], fill=(255, 255, 255, al), width=(3 if major else 2) * S)
    return im, c


def _finish(im, c, r, colour, deg, ghosts, target, locked, lock_pulse, power):
    R = r * S
    d = ImageDraw.Draw(im)
    col = tuple(int(v) for v in colour)
    # the mark: a coloured notch just outside the rim
    tip = _pol(c, R + 1 * S, target)
    b1, b2 = _pol(c, R + 15 * S, target - 5), _pol(c, R + 15 * S, target + 5)
    d.polygon([tip, b1, b2], fill=col + (int((170 + 85 * locked) * power),))
    # needle: ghost samples of its last frame first (motion blur), then the needle itself
    for g, ga in ghosts:
        d.line([_pol(c, -10 * S, g), _pol(c, R - 20 * S, g)], fill=(255, 255, 255, int(ga * power)), width=4 * S)
    d.line([_pol(c, -12 * S, deg), _pol(c, R - 20 * S, deg)], fill=(255, 255, 255, int(255 * power)), width=5 * S)
    d.line([_pol(c, R - 34 * S, deg), _pol(c, R - 20 * S, deg)], fill=col + (int(255 * power),), width=5 * S)
    d.ellipse([c[0] - 11 * S, c[1] - 11 * S, c[0] + 11 * S, c[1] + 11 * S], fill=(26, 29, 34, int(255 * power)),
              outline=(255, 255, 255, int(200 * power)), width=2 * S)
    if lock_pulse > 0:  # a ring that pulses out from the hub as the needle locks
        pr = (14 + 60 * lock_pulse) * S
        d.ellipse([c[0] - pr, c[1] - pr, c[0] + pr, c[1] + pr], outline=col + (int(200 * (1 - lock_pulse) * power),), width=3 * S)
    return im


def ev_dial_panel(self, e):
    sid = e.get('id', 'dials')
    r = e.get('r', 68)
    px0, py0, px1, py1 = e['panel']
    PW, PH = int(px1 - px0), int(py1 - py0)
    t_in, t_set0, t_out = self.T(e['in_at']), self.T(e['settle_at']), self.T(e['out'])
    ox, oy = compass(e.get('out_dir', 'E'))
    fnt = kit.sf('display_semibold', e.get('label_size', 34))
    dials = e['dials']
    n = len(dials)
    ticks = list(range(-SPAN, SPAN + 1, 9))
    info = []
    for k, dl in enumerate(dials):
        lab, lpad = kit.text_img(dl['label'], fnt, kit.col('white'), shadow=False)
        cx = PW * (k + 0.5) / n
        info.append({'lab': lab, 'lpad': lpad, 'c': (cx, 22 + r + 26), 'on': self.T(dl['at']), 'target': dl['target_deg'],
                     'colour': dl.get('colour', [120, 220, 150]), 'set': t_set0 + k * e.get('settle_stagger_s', 0.14),
                     'phase': 1.7 * k + 0.6})
    self.safe_box(sid, px0, py0, px1, py1, t_in, t_out)

    def slide(tt):
        """Panel offset (dx, dy): in from the exit side over 0.45 s (eased out), out the same way (eased in)."""
        if tt < t_out:
            u = ease_out(min(1.0, max(0.0, (tt - t_in) / 0.45)))
            return (1 - u) * ox, (1 - u) * oy  # compass(): from outside the frame
        v = ease_in((tt - t_out) / 0.42)
        return (None, None) if v >= 1 else (ox * v, oy * v)

    def panel(tt):
        im = Image.new('RGBA', (PW * S, PH * S), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.rounded_rectangle([0, 0, PW * S - 1, PH * S - 1], 30 * S, fill=(12, 14, 18, 190))
        top = Image.new('L', (PW * S, PH * S), 0)  # a faint sheen across the top third (glass)
        ImageDraw.Draw(top).rounded_rectangle([0, 0, PW * S - 1, PH * S - 1], 30 * S, fill=255)
        sheen = Image.new('RGBA', im.size, (255, 255, 255, 0))
        g = np.linspace(26, 0, PH * S // 3).astype(np.uint8)
        a = np.zeros((PH * S, PW * S), np.uint8)
        a[:len(g)] = g[:, None]
        sheen.putalpha(Image.fromarray(np.minimum(a, np.asarray(top))))
        im.alpha_composite(sheen)
        d.rounded_rectangle([0, 0, PW * S - 1, PH * S - 1], 30 * S, outline=(255, 255, 255, 46), width=2 * S)
        for k, f in enumerate(info):
            power = min(1.0, max(0.0, (tt - f['on'] + 0.12) / 0.2))
            deg = _needle(tt, f['on'], f['set'], f['target'], f['phase'])
            ghosts = []
            for j, frac in enumerate((0.75, 0.5, 0.25)):
                g_deg = _needle(tt - frac * FRAME_S * 1.5, f['on'], f['set'], f['target'], f['phase'])
                if abs(g_deg - deg) > 1.5:
                    ghosts.append((g_deg, 38 - 10 * j))  # faint: a blur of the needle, not more needles
            # ticks light as the needle passes them in the self-test, then fade (0.4 s)
            lit = []
            for a_ in ticks:
                best = 0.0
                for back in np.linspace(0, 0.4, 9):
                    if abs(_needle(tt - back, f['on'], f['set'], f['target'], f['phase']) - a_) < 5 and tt - back < f['on'] + 0.75:
                        best = max(best, 1 - back / 0.4)
                lit.append(best if tt >= f['on'] else 0.0)
            locked = min(1.0, max(0.0, (tt - f['set'] - 0.35) / 0.2))
            lp = (tt - f['set'] - 0.35) / 0.45
            lock_pulse = lp if 0 < lp < 1 else 0.0
            dial, c = _dial_img(r, f['colour'], deg, lit, locked, max(0.25, power))
            dial = _finish(dial, c, r, f['colour'], deg, ghosts, f['target'], locked, lock_pulse, max(0.25, power))
            im.alpha_composite(dial, (int(f['c'][0] * S - dial.width / 2), int(f['c'][1] * S - dial.height / 2)))
            lab = f['lab']
            ly = int((f['c'][1] + r + 22) * S)
            lab2 = lab.resize((lab.width * S, lab.height * S), Image.LANCZOS)
            lab2.putalpha(lab2.getchannel('A').point(lambda v: int(v * (0.45 + 0.55 * power))))
            im.alpha_composite(lab2, (int(f['c'][0] * S - lab2.width / 2), ly))
            # the lamp under the label: dim, then the dial's colour once locked
            lc = (int(f['c'][0] * S), ly + lab2.height + 4 * S)
            lr = 5 * S
            lamp = tuple(int(30 + (v - 30) * locked) for v in f['colour']) + (int(110 + 145 * locked),)
            d2 = ImageDraw.Draw(im)
            d2.ellipse([lc[0] - lr, lc[1] - lr, lc[0] + lr, lc[1] + lr], fill=lamp)
        return im.resize((PW, PH), Image.LANCZOS)

    def dyn(tt):
        if tt < t_in:
            return None, 0, 0
        dx, dy = slide(tt)
        if dx is None:
            return None, 0, 0
        img, p = stage.shadowed(panel(tt), {'dx': 0, 'dy': 8, 'blur': 24, 'opacity': 0.4})
        x, y = px0 - p + dx, py0 - p + dy
        d0 = slide(tt - 1.5 * FRAME_S)
        if d0[0] is not None and tt - 1.5 * FRAME_S >= t_in:
            return smear(img, x, y, dx - d0[0], dy - d0[1])  # motion blur along the slide
        return img, x, y

    sp = SmoothSprite(self, sid, None, 0, 0, t_in, 'none', 0, order=60, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    play(self, 'ch2_card', t_in)
    for f in info:
        play(self, 'ch2_slide', f['on'])            # the self-test sweep
        play(self, 'ch2_lock', f['set'] + 0.35)    # the needle locks
    play(self, 'ch2_out', t_out)
