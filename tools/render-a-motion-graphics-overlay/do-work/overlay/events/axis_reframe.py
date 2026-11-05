"""axis_reframe (lane ch2): the debate drawn as a line between two camps, each camp's reason pinned under its end as he
gives it, and then the line itself swings upright into one new axis: the question was never which end, it is how far up
(technique: matching-token transform / axis swap, 3Blue1Brown; filmcraft/options-ch2/techniques/axis-reframe.md).

White SF Pro and white line over footage with the soft wide shadow; every frame drawn (smooth, eased).

    {"type": "axis_reframe", "id": "debate", "a": [x, y], "b": [x, y],          the line's two ends (horizontal)
     "draw_at": s,                                                              the line draws out from its middle
     "ends": [{"text": "animal-based", "side": "a", "at": s, "bump": [s, ...]},  label above an end; bump = a small
              {"text": "vegan", "side": "b", "at": s, "bump": [s]}],            lift-and-settle when he names that camp again
     "reasons": [{"text": "...", "side": "b", "at": s}],                        smaller lines under an end
     "swing_at": s, "swing_s": 0.9, "axis_label": "nutrients",                  the line turns upright about its middle;
     "out": s, "out_dir": "W", "size": 46, "reason_size": 34}                   an arrowhead and the new label arrive
"""
import math
from PIL import Image, ImageDraw
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, compass, ease_in, ease_out
from overlay.helpers.motion_smear import smeared


def _ease_io(u):
    u = min(max(u, 0.0), 1.0)
    return u * u * (3 - 2 * u)


def ev_axis_reframe(self, e):
    sid = e.get('id', 'axis')
    (ax, ay), (bx, by) = e['a'], e['b']
    cx, cy = (ax + bx) / 2, (ay + by) / 2
    half = math.hypot(bx - ax, by - ay) / 2
    t_draw, t_swing, t_out = self.T(e['draw_at']), self.T(e['swing_at']), self.T(e['out'])
    swing_s = e.get('swing_s', 0.9)
    ox, oy = compass(e.get('out_dir', 'W'))
    sh = look.LOOK['text_shadow']
    white = kit.col('white')

    def leave(tt):
        if tt < t_out:
            return 0.0, 0.0
        u = ease_in((tt - t_out) / 0.45)
        return (None, None) if u >= 1 else (ox * u, oy * u)

    def fade_before_swing(tt):  # the camps' words fade where they stand in the 0.3 s before the line moves: a word that
        return 1.0 - min(1.0, max(0.0, (tt - t_swing + 0.3) / 0.3))  # vanished while riding the swing would read as a flicker

    # ---- the line (and, after the swing, its arrowhead)
    def line_dyn(tt):
        dx, dy = leave(tt)
        if dx is None:
            return None, 0, 0
        grow = ease_out((tt - t_draw) / 0.5)
        ang = -90.0 * _ease_io((tt - t_swing) / swing_s)  # degrees; 0 = horizontal, -90 = upright (screen up)
        L = half * grow
        ca, sa = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        p0 = (cx - L * ca, cy - L * sa)
        p1 = (cx + L * ca, cy + L * sa)
        pad = 40
        x0, y0 = min(p0[0], p1[0]) - pad, min(p0[1], p1[1]) - pad
        layer = Image.new('RGBA', (int(abs(p1[0] - p0[0]) + 2 * pad), int(abs(p1[1] - p0[1]) + 2 * pad)), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        q0, q1 = (p0[0] - x0, p0[1] - y0), (p1[0] - x0, p1[1] - y0)
        d.line([q0, q1], fill=white + (255,), width=6)
        arrow = _ease_io((tt - t_swing - swing_s * 0.8) / 0.3)
        ticks = 1.0 - arrow
        for q in (q0, q1):  # end ticks while it is a two-camp line
            if ticks > 0.02 and grow > 0.98:
                tx, ty = -sa * 16 * ticks, ca * 16 * ticks
                d.line([(q[0] - tx, q[1] - ty), (q[0] + tx, q[1] + ty)], fill=white + (255,), width=6)
        if arrow > 0.02:  # arrowhead on the upper end once upright
            tip = q1 if q1[1] < q0[1] else q0
            s = 26 * arrow
            d.polygon([(tip[0], tip[1] - 6), (tip[0] - s * 0.75, tip[1] + s), (tip[0] + s * 0.75, tip[1] + s)], fill=white + (255,))
        img, p = stage.shadowed(layer, sh)
        return img, x0 - p + dx, y0 - p + dy

    sp = SmoothSprite(self, sid + '-line', None, 0, 0, t_draw, 'none', 0, order=58, jitter=False)
    sp.dynamic = smeared(line_dyn, leave)
    self.add(sp)
    self.sound('marker', t_draw)

    # ---- words: end labels above the ends, reasons under them; all fade as the line starts to swing
    def word(text, size, anchor_x, top, align, t_in, bumps=(), sub=''):
        fnt = kit.sf('display_bold' if size >= 44 else 'display_semibold', size)
        im, pad = kit.text_img(text, fnt, white, align=align)
        w = im.width - 2 * pad
        x = anchor_x if align == 'left' else anchor_x - w
        self.safe_box(f'{sid}-{sub}', x, top, x + w, top + im.height - 2 * pad, t_in, t_swing)
        bump_t = [self.T(b) for b in bumps]

        def dyn(tt):
            dx, dy = leave(tt)
            if dx is None:
                return None, 0, 0
            u = ease_out((tt - t_in) / 0.18) * fade_before_swing(tt)
            if u <= 0.01:
                return None, 0, 0
            lift = sum(10 * math.sin(math.pi * min(1.0, (tt - b) / 0.45)) for b in bump_t if b <= tt < b + 0.45)
            img = im
            if u < 1:
                img = im.copy()
                img.putalpha(im.getchannel('A').point(lambda v: int(v * u)))
            return img, x - pad + dx, top - pad + (1 - min(1.0, (tt - t_in) / 0.18)) * 12 - lift + dy
        s = SmoothSprite(self, f'{sid}-{sub}', None, 0, 0, t_in, 'none', 0, order=60, jitter=False)
        s.dynamic = smeared(dyn, leave)
        self.add(s)
        self.sound('word_in', t_in)
        for b in bump_t:
            self.sound('tick', b)

    size, rsize = e.get('size', 46), e.get('reason_size', 34)
    for k, en in enumerate(e['ends']):
        left = en['side'] == 'a'
        fnt_h = kit.sf('display_bold', size).getmetrics()
        word(en['text'], size, ax if left else bx, (ay if left else by) - 30 - sum(fnt_h), 'left' if left else 'right',
             self.T(en['at']), en.get('bump', ()), f'end{k}')
    for k, rs in enumerate(e['reasons']):
        left = rs['side'] == 'a'
        word(rs['text'], rsize, ax if left else bx, (ay if left else by) + 30, 'left' if left else 'right',
             self.T(rs['at']), (), f'reason{k}')

    # ---- the new axis label, left of where the arrow tip comes to rest; it comes up early in the swing, so the frame is
    # never left with a bare line between the two readings of it
    fnt = kit.sf('display_bold', e.get('axis_size', 56))
    lim, lpad = kit.text_img(e['axis_label'], fnt, white)
    t_lab = t_swing + swing_s * 0.25
    lx, ly = cx - 34 - (lim.width - 2 * lpad), cy - half - (lim.height - 2 * lpad) * 0.35  # left of the tip: the tip swings in from the right
    self.safe_box(sid + '-axis', lx, ly, lx + lim.width - 2 * lpad, ly + lim.height - 2 * lpad, t_lab, t_out)

    def lab_dyn(tt):
        dx, dy = leave(tt)
        if dx is None:
            return None, 0, 0
        u = ease_out((tt - t_lab) / 0.35)
        img = lim
        if u < 1:
            img = lim.copy()
            img.putalpha(lim.getchannel('A').point(lambda v: int(v * u)))
        return img, lx - lpad + dx, ly - lpad + (1 - u) * 12 + dy
    s = SmoothSprite(self, sid + '-axis', None, 0, 0, t_lab, 'none', 0, order=60, jitter=False)
    s.dynamic = smeared(lab_dyn, leave)
    self.add(s)
    self.sound('slide_in', t_swing)
    self.sound('word_in', t_lab)
    self.sound('slide_out', t_out)
