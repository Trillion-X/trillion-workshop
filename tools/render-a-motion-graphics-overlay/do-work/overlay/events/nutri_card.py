"""nutri_card (lane ch2, round 2): an informational card that adds what he did not say, as one dark card in the free space
of the frame: a title, the serving and the taste, then one row per item with its value and a bar that grows on the word
(technique: bar grow, awesome-ai-motion #241, rows staggered 0.16 s with power2.out; value label, library/techniques/
value-label.md: every row shows its value; filmcraft/options-ch2/assets/r2-m05/technique-nutri-card.md).

The card is one element: all its words are there when it lands (synthetic-9710181698cd); only the bars grow, on their word.
A dark charcoal card, white text: it reads against the bright window behind it (synthetic-6f427677987b). It slides in and
out along one compass direction with motion blur (smooth style, synthetic-4015c76f9424).

    {"type": "nutri_card", "id": "yeast", "box": [x0, y0, x1, y1],
     "title": "...", "caption": "...", "note": "...",                 serving line and taste line under the title
     "rows": [{"label": "B1", "value": "520%", "pct": 520}, ...],    bar length = pct against the largest row
     "mark": {"pct": 100, "label": "a day"},                          a thin tick across the bars at pct, labelled
     "footer": [{"value": "5 g", "label": "protein"}, ...],
     "at": s, "start": s (bars grow), "out": s, "in_dir": "E", "out_dir": "E"}
"""
from PIL import Image, ImageDraw
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, compass, ease_in, ease_out
from overlay.helpers.motion_smear import smeared
from overlay.helpers.sound_classes import play

CARD = (20, 20, 22)
WHITE = (255, 255, 255)
DIM = (178, 178, 184)
TRACK = (58, 58, 62)


def _power2_out(u):
    u = min(max(u, 0.0), 1.0)
    return 1 - (1 - u) ** 2


def ev_nutri_card(self, e):
    sid = e.get('id', 'card')
    x0, y0, x1, y1 = e['box']
    w, h = x1 - x0, y1 - y0
    t_in, t_grow, t_out = self.T(e['at']), self.T(e['start']), self.T(e['out'])
    pad = 34
    f_title = kit.sf('display_bold', 50)
    f_cap = kit.sf('text_medium', 28)
    f_row = kit.sf('text_semibold', 34)
    f_val = kit.sf('display_bold', 34)
    f_mark = kit.sf('text_medium', 22)
    f_foot_v = kit.sf('display_bold', 38)
    f_foot_l = kit.sf('text_medium', 24)

    # the card face without bars: everything that does not move
    face = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(face)
    d.rounded_rectangle([0, 0, w - 1, h - 1], 30, fill=CARD + (238,))
    y = pad - 6
    d.text((pad, y), e['title'], font=f_title, fill=WHITE + (255,))
    y += 64
    d.text((pad, y), e['caption'], font=f_cap, fill=DIM + (255,))
    y += 38
    d.text((pad, y), e['note'], font=f_cap, fill=DIM + (255,))
    y += 58
    rows = e['rows']
    bar_x0, bar_x1 = pad + 112, w - pad - 112
    row_h = 58
    top_rows = y
    vmax = max(r['pct'] for r in rows)
    mark_x = bar_x0 + (bar_x1 - bar_x0) * e['mark']['pct'] / vmax
    for i, r in enumerate(rows):
        ry = top_rows + i * row_h
        d.text((pad, ry + 6), r['label'], font=f_row, fill=WHITE + (255,))
        d.rounded_rectangle([bar_x0, ry + 18, bar_x1, ry + 34], 8, fill=TRACK + (255,))
        vw = f_val.getlength(r['value'])
        d.text((w - pad - vw, ry + 4), r['value'], font=f_val, fill=WHITE + (255,))
    y_mark0, y_mark1 = top_rows + 8, top_rows + len(rows) * row_h - 12
    y = top_rows + len(rows) * row_h + 4
    ml = e['mark']['label']
    d.text((mark_x - f_mark.getlength(ml) / 2, y), ml, font=f_mark, fill=DIM + (255,))
    y += 46
    d.line([(pad, y), (w - pad, y)], fill=TRACK + (255,), width=2)
    y += 20
    cols = e['footer']
    cw = (w - 2 * pad) / len(cols)
    for k, c in enumerate(cols):
        cx = pad + k * cw
        d.text((cx, y), c['value'], font=f_foot_v, fill=WHITE + (255,))
        d.text((cx, y + 48), c['label'], font=f_foot_l, fill=DIM + (255,))
    if y + 48 + 34 > h - 12:
        raise SystemExit(f'{sid}: the card box is too short for its rows ({y + 82} > {h - 12})')

    grow = [t_grow + 0.16 * i for i in range(len(rows))]

    def card(tt):
        im = face.copy()
        dd = ImageDraw.Draw(im)
        for i, r in enumerate(rows):
            u = _power2_out((tt - grow[i]) / 0.55)
            if u <= 0:
                continue
            ry = top_rows + i * row_h
            xe = bar_x0 + max(16, (bar_x1 - bar_x0) * r['pct'] / vmax * u)
            dd.rounded_rectangle([bar_x0, ry + 18, xe, ry + 34], 8, fill=WHITE + (255,))
        for yy in range(int(y_mark0), int(y_mark1), 12):  # the 100% tick, dashed white, over the bars
            dd.line([(mark_x, yy), (mark_x, yy + 6)], fill=(255, 255, 255, 230), width=3)
        img, p = stage.shadowed(im, {'dx': 0, 'dy': 10, 'blur': 26, 'opacity': 0.5})
        return img, p

    def unit(d):
        vx, vy = compass(d)
        n = max(1e-6, (vx * vx + vy * vy) ** 0.5)
        return vx / n, vy / n

    def to_leave(vx, vy):  # distance along (vx, vy) until the card's shadowed box is off the frame
        far = [(stage.W + 60 - x0) / vx if vx > 0 else (x1 + 60) / -vx if vx < 0 else 1e9,
               (stage.H + 60 - y0) / vy if vy > 0 else (y1 + 60) / -vy if vy < 0 else 1e9]
        return min(far)
    ix, iy = unit(e.get('in_dir', 'E'))
    ox, oy = unit(e.get('out_dir', 'E'))
    travel_in, travel_out = to_leave(ix, iy), to_leave(ox, oy)

    def offset(tt):
        if tt < t_in:
            return travel_in * ix, travel_in * iy
        if tt < t_in + 0.42:
            u = 1 - ease_out((tt - t_in) / 0.42)
            return travel_in * ix * u, travel_in * iy * u
        if tt < t_out:
            return 0.0, 0.0
        u = ease_in((tt - t_out) / 0.4)
        return (None, None) if u >= 1 else (travel_out * ox * u, travel_out * oy * u)

    def dyn(tt):
        if tt < t_in:
            return None, 0, 0
        dx, dy = offset(tt)
        if dx is None:
            return None, 0, 0
        img, p = card(tt)
        return img, x0 - p + dx, y0 - p + dy

    self.safe_box(sid, x0, y0, x1, y1, t_in + 0.42, t_out)
    sp = SmoothSprite(self, sid, None, 0, 0, t_in, 'none', 0, order=62, jitter=False)
    sp.dynamic = smeared(dyn, offset)
    self.add(sp)
    play(self, 'ch2_card', t_in)
    play(self, 'ch2_line', t_grow, max_s=min(0.7, 0.16 * len(rows) + 0.3))
    play(self, 'ch2_out', t_out)
