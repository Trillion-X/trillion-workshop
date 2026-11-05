"""focus_tapes (lane ch2, round 2): "perfectly dialed in" as a lens pulling focus. One precision tape readout per named
quantity slides in on its word: a scale tape scrolls behind a fixed pointer, hunting past a coloured target band, and the
whole tape is out of focus while it hunts (defocus grows with the distance from the band). On the settle word every tape
brakes on a damped spring so its band stops under the pointer, the tape snaps sharp, the band fills solid and a lamp
lights, with a knock as each locks; the readouts slide back out on the exit word.

Techniques: tape-scroll-fixed-pointer (an aircraft speed tape: the pointer stays, the scale moves, a spring brake at the
end; video-shotcraft gauge-readout-moves); rack focus / focus pull (defocus that resolves on the beat; blur-resolve,
gongnyang #58); damped-spring settle (round 1 gauge_settle); motion blur along the tape's travel and the slides
(_ch2_motion). Sounds: _ch2_sound. filmcraft/options-ch2/techniques/focus-tapes.md.

    {"type": "focus_tapes", "id": "tapes", "at_x": x, "at_y": y, "row_h": 96, "tape_w": 330, "label_w": 190,
     "settle_at": s, "settle_stagger_s": 0.14, "out": s, "out_dir": "E", "label_size": 34,
     "rows": [{"label": "nutrients", "at": s, "colour": [r, g, b], "phase": 0.0}]}
"""
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, compass, ease_in, ease_out
from overlay.helpers.motion_smear import FRAME_S, smear
from overlay.helpers.sound_classes import play
S = 2


def _offset(tt, t_on, t_set, phase):
    """Tape offset from the band (px): enters far off, hunts in eased hops either side of the band, then from t_set a
    damped spring brake onto it."""
    def hunt(t):
        if t < t_on:
            return 170.0
        hop = 0.5
        i = math.floor((t - t_on) / hop)
        f = (t - t_on) / hop - i
        f = f * f * (3 - 2 * f)

        def p(j):
            return 170.0 if j < 0 else 72 * math.sin(2.1 * j + phase) + 26 * math.sin(4.7 * j + 2 * phase)
        return p(i - 1) + (p(i) - p(i - 1)) * f
    if tt < t_set:
        return hunt(tt)
    d0 = hunt(t_set)
    v = tt - t_set
    return d0 * math.exp(-6.0 * v) * math.cos(9.5 * v)


def _tape(w, h, offset, colour, locked):
    """The readout window: dark glass, scale ticks scrolled by `offset`, the target band, the fixed pointer."""
    W, H = w * S, h * S
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, W - 1, H - 1], 14 * S, fill=(12, 14, 18, 200), outline=(255, 255, 255, 50), width=2 * S)
    tape = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    td = ImageDraw.Draw(tape)
    cx = W / 2
    col = tuple(int(v) for v in colour)
    band = 30 * S
    bx = cx + offset * S
    td.rounded_rectangle([bx - band / 2, 12 * S, bx + band / 2, H - 12 * S], 6 * S,
                         fill=col + (int(90 + 140 * locked),), outline=col + (230,), width=2 * S)
    step = 22 * S
    first = int(math.floor((-bx) / step)) - 1
    for k in range(first, first + W // step + 3):
        x = bx + k * step
        if x < 4 * S or x > W - 4 * S:
            continue
        major = k % 5 == 0
        y0 = H / 2 - (16 if major else 9) * S
        y1 = H / 2 + (16 if major else 9) * S
        td.line([(x, y0), (x, y1)], fill=(255, 255, 255, 255 if major else 205), width=(4 if major else 3) * S)
    return im, tape, cx


def ev_focus_tapes(self, e):
    sid = e.get('id', 'tapes')
    x0, y0 = e['at_x'], e['at_y']
    rh, tw, lw = e.get('row_h', 96), e.get('tape_w', 330), e.get('label_w', 190)
    th = int(rh * 0.62)
    t_set0, t_out = self.T(e['settle_at']), self.T(e['out'])
    ox, oy = compass(e.get('out_dir', 'E'))
    fnt = kit.sf('display_semibold', e.get('label_size', 34))
    rows = e['rows']
    width = lw + tw
    self.safe_box(sid, x0, y0, x0 + width, y0 + rh * len(rows), self.T(rows[0]['at']) - 0.3, t_out)

    for k, row in enumerate(rows):
        t_on = self.T(row['at'])
        t_set = t_set0 + k * e.get('settle_stagger_s', 0.14)
        lab, lpad = kit.text_img(row['label'], fnt, kit.col('white'), shadow=False)
        colour = row.get('colour', [120, 220, 150])
        phase = row.get('phase', 1.6 * k)
        ry = y0 + k * rh

        def slide(tt, t_on=t_on, k=k):
            if tt < t_out + 0.05 * k:
                u = ease_out(min(1.0, max(0.0, (tt - t_on + 0.25) / 0.4)))
                return (1 - u) * ox, (1 - u) * oy  # compass(): from outside the frame
            v = ease_in((tt - t_out - 0.05 * k) / 0.4)
            return (None, None) if v >= 1 else (ox * v, oy * v)

        def row_img(tt, t_on=t_on, t_set=t_set, lab=lab, colour=colour, phase=phase):
            off = _offset(tt, t_on, t_set, phase)
            locked = min(1.0, max(0.0, (tt - t_set - 0.4) / 0.2))
            win, tape, cx = _tape(tw, th, off, colour, locked)
            # motion blur of the scroll: the tape's own travel over 1.5 frames, then defocus by distance from the band
            prev = _offset(tt - 1.5 * FRAME_S, t_on, t_set, phase)
            tape, _, _ = smear(tape, 0, 0, (off - prev) * S, 0)
            pad = (tape.width - win.width) // 2
            tape = tape.crop((pad, (tape.height - win.height) // 2, pad + win.width, (tape.height - win.height) // 2 + win.height))
            blur = min(2.4, abs(off) / 45.0) * S  # out of focus, but the scale stays visible
            if blur > 0.4:
                tape = tape.filter(ImageFilter.GaussianBlur(blur))
            mask = Image.new('L', win.size, 0)
            ImageDraw.Draw(mask).rounded_rectangle([2 * S, 2 * S, win.width - 3 * S, win.height - 3 * S], 12 * S, fill=255)
            clip = Image.new('RGBA', win.size, (0, 0, 0, 0))
            clip.paste(tape, (0, 0), Image.fromarray(np.minimum(np.asarray(mask), np.asarray(tape.getchannel('A')))))
            win.alpha_composite(clip)
            d = ImageDraw.Draw(win)
            d.line([(cx, 6 * S), (cx, win.height - 6 * S)], fill=(255, 255, 255, 255), width=3 * S)  # the fixed pointer
            d.polygon([(cx - 9 * S, 0), (cx + 9 * S, 0), (cx, 10 * S)], fill=(255, 255, 255, 255))
            d.polygon([(cx - 9 * S, win.height), (cx + 9 * S, win.height), (cx, win.height - 10 * S)], fill=(255, 255, 255, 255))
            win = win.resize((tw, th), Image.LANCZOS)
            out = Image.new('RGBA', (width + 30, rh), (0, 0, 0, 0))
            # the label sits on its own glass chip, so it reads over the bright counter and stays one solid shape as it moves
            ImageDraw.Draw(out).rounded_rectangle([0, (rh - th) // 2, lw - 10, (rh + th) // 2], 12, fill=(12, 14, 18, 190), outline=(255, 255, 255, 50), width=2)
            out.alpha_composite(lab, (16 - lpad, (rh - lab.height) // 2 - 4))
            out.alpha_composite(win, (lw, (rh - th) // 2))
            lr = 6  # the lamp left of the label: dim, then the band's colour once locked
            lamp = tuple(int(40 + (v - 40) * locked) for v in colour) + (int(120 + 135 * locked),)
            ImageDraw.Draw(out).ellipse([width + 12, rh // 2 - lr, width + 12 + 2 * lr, rh // 2 + lr], fill=lamp)
            return out

        def dyn(tt, t_on=t_on, slide=slide, row_img=row_img, ry=ry):
            if tt < t_on - 0.25:
                return None, 0, 0
            dx, dy = slide(tt)
            if dx is None:
                return None, 0, 0
            img, p = stage.shadowed(row_img(tt), {'dx': 0, 'dy': 6, 'blur': 18, 'opacity': 0.42})
            x, y = x0 - p + dx, ry - p + dy
            d0 = slide(tt - 1.5 * FRAME_S)
            if d0[0] is not None and tt - 1.5 * FRAME_S >= t_on - 0.25:
                return smear(img, x, y, dx - d0[0], dy - d0[1])
            return img, x, y

        sp = SmoothSprite(self, f'{sid}{k}', None, 0, 0, t_on - 0.25, 'none', 0, order=60, jitter=False)
        sp.dynamic = dyn
        self.add(sp)
        play(self, 'ch2_slide', t_on - 0.25)
        play(self, 'ch2_lock', t_set + 0.4)
    play(self, 'ch2_out', t_out)
