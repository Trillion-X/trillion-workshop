"""The `chart3` event. Ported from filmcraft/options-ch1/tools-round-3/r3.py:704."""
import math
import numpy as np
from PIL import Image, ImageDraw

from overlay import kit, look, stage


# ---------- the full-range chart ----------
def ev_chart3(self, e):
    """Graph-paper card. Two axes (calories, protein) draw on their words with a dot in the low-calorie,
    high-protein corner; on e.open_at they swing out into one spoke per item. Each item says what it means as
    data: better 'more' (arrow out, solid) or 'less' (dashed, chevron pointing in, the word 'less' under its
    label), and amount (0..1, where the filled shape reaches). Each label sits with its picture outside the spoke
    tip, at the first place where it crosses no spoke, arrow, fill or other label (tested, not eyeballed)."""
    Sw, Sh = e['size']
    self.seed += 1
    card = Image.new('RGBA', (Sw, Sh), (247, 247, 241, 255))
    d = ImageDraw.Draw(card)
    for k in range(0, max(Sw, Sh), 24):
        d.line([(k, 0), (k, Sh)], fill=kit.col('grid') + (110,), width=1)
        d.line([(0, k), (Sw, k)], fill=kit.col('grid') + (110,), width=1)
    card = stage.apply_texture(card, 'sheet', self.seed, 0.3)
    mask = Image.new('L', (Sw, Sh), 0)
    ImageDraw.Draw(mask).polygon(stage.torn_polygon(Sw, Sh, 5, self.seed, step=9), fill=255)
    card.putalpha(mask)
    ink = kit.col('ink')
    fl = kit.face(e['label_font'], e['label_px'])
    fless = kit.face(e['less_font'], e['less_px'])
    items = e['items']
    n = len(items)
    cx, cy = Sw / 2, Sh / 2 + e.get('centre_dy', 0)
    R0 = e['radius']
    ox, oy = Sw * 0.16, Sh * 0.84
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    ax_t = [self.T(x) for x in e['axis_at']]
    dot_t, t_open = self.T(e['dot_at']), self.T(e['open_at'])
    sp_t = [self.T(it['at']) if 'at' in it else ax_t[k] for k, it in enumerate(items)]
    ang = [math.radians(-90 + k * 360 / n) for k in range(n)]
    tips = [(cx + R0 * math.cos(a), cy + R0 * math.sin(a)) for a in ang]
    icons = [self.chart_icon(it['icon'], e['icon_px']) for it in items]

    # 1. the label blocks (picture above the label, 'less' under it), placed by collision test on the opened chart
    def block(k):
        it = items[k]
        ic = icons[k]
        lw = fl.getlength(it['label'])
        ls = fless.getlength('less is better') if it['better'] == 'less' else 0
        bw = int(max(lw, ls, ic.width)) + 8
        bh = ic.height + 6 + e['label_px'] + (e['less_px'] + 4 if ls else 0) + 6
        return bw, bh
    segs = []
    for k in range(n):
        segs.append((cx, cy, tips[k][0], tips[k][1]))
    fill_pts = [(cx + R0 * it['amount'] * math.cos(a), cy + R0 * it['amount'] * math.sin(a)) for it, a in zip(items, ang)]

    def seg_hits_rect(s, r):
        x0, y0, x1, y1 = s
        for u in np.linspace(0, 1, 60):
            px, py = x0 + (x1 - x0) * u, y0 + (y1 - y0) * u
            if r[0] <= px <= r[2] and r[1] <= py <= r[3]:
                return True
        return False
    fill_mask = Image.new('L', (Sw, Sh), 0)
    ImageDraw.Draw(fill_mask).polygon(fill_pts, fill=255)
    fill_np = np.asarray(fill_mask)
    placed = []
    for k in range(n):
        bw, bh = block(k)
        a = ang[k]
        ok = None
        for extra in range(0, 140, 3):
            for tang in (0, 12, -12, 24, -24, 40, -40):
                dist = R0 + 22 + extra
                bx = cx + dist * math.cos(a) + tang * -math.sin(a)
                by = cy + dist * math.sin(a) + tang * math.cos(a)
                # anchor: the block's nearest side faces the tip
                rx0 = bx - bw / 2 * (1 - math.cos(a))
                ry0 = by - bh / 2 * (1 - math.sin(a))
                r = (rx0 - 6, ry0 - 6, rx0 + bw + 6, ry0 + bh + 6)
                if r[0] < 10 or r[1] < 10 or r[2] > Sw - 10 or r[3] > Sh - 10:
                    continue
                if any(seg_hits_rect(s, r) for s in segs):
                    continue
                xi0, yi0, xi1, yi1 = [int(max(0, v)) for v in r]
                if fill_np[yi0:min(Sh, yi1), xi0:min(Sw, xi1)].any():
                    continue
                if any(not (r[2] < p[0] or r[0] > p[2] or r[3] < p[1] or r[1] > p[3]) for p in placed):
                    continue
                ok = r
                break
            if ok:
                break
        if not ok:
            raise SystemExit(f'{self.id}: no clear place for the label "{items[k]["label"]}" on a {Sw}x{Sh} chart')
        placed.append(ok)

    def draw_block(im, k, alpha=255):
        it = items[k]
        x0, y0, x1, y1 = placed[k]
        bx = (x0 + x1) / 2
        ic = icons[k]
        im.alpha_composite(ic, (int(bx - ic.width / 2), int(y0 + 6)))
        dd = ImageDraw.Draw(im)
        ly = y0 + 6 + ic.height + 6
        dd.text((bx, ly), it['label'], font=fl, fill=ink + (alpha,), anchor='mt')
        if it['better'] == 'less':
            dd.text((bx, ly + e['label_px'] + 4), 'less is better', font=fless, fill=ink + (alpha,), anchor='mt')

    def dashed(dd, p0, p1, w, dash=14, gap=9):
        L = math.dist(p0, p1)
        s = 0.0
        while s < L:
            a0, a1 = s / L, min(L, s + dash) / L
            dd.line([(p0[0] + (p1[0] - p0[0]) * a0, p0[1] + (p1[1] - p0[1]) * a0), (p0[0] + (p1[0] - p0[0]) * a1, p0[1] + (p1[1] - p0[1]) * a1)], fill=ink + (255,), width=w)
            s += dash + gap
    cache = {}

    def draw(tt):
        key = round(tt * stage.FPS / stage.HOLD)
        if key in cache:
            return cache[key]
        im = card.copy()
        dd = ImageDraw.Draw(im)
        u = stage.ease_out((tt - t_open) / 0.6) if tt >= t_open else 0.0
        if u > 0:  # the filled shape: where each item reaches (amount), under the spokes
            shown = [k for k in range(n) if (k < 2 or tt >= sp_t[k] + 0.3)]
            if len(shown) >= 3:
                pts = [(cx + (fill_pts[k][0] - cx) * min(1.0, u), cy + (fill_pts[k][1] - cy) * min(1.0, u)) for k in shown]
                ov = Image.new('RGBA', im.size, (0, 0, 0, 0))
                ImageDraw.Draw(ov).polygon(pts, fill=ink + (34,), outline=ink + (190,))
                im.alpha_composite(ov)
                dd = ImageDraw.Draw(im)
        for k in range(n):
            tk = ax_t[k] if k < 2 else sp_t[k]
            if tt < tk:
                continue
            grow = stage.ease_out((tt - tk) / 0.3)
            tx, ty = tips[k]
            if k == 0:
                sx0, sy0, ex, ey = ox, oy, Sw * 0.9, oy
            elif k == 1:
                sx0, sy0, ex, ey = ox, oy, ox, Sh * 0.12
            else:
                sx0, sy0, ex, ey = cx, cy, tx, ty
            if k < 2:
                sx0 += (cx - sx0) * u; sy0 += (cy - sy0) * u
                ex += (tx - ex) * u; ey += (ty - ey) * u
            x1, y1 = sx0 + (ex - sx0) * grow, sy0 + (ey - sy0) * grow
            less = items[k]['better'] == 'less' and (k >= 2 or u > 0.5)
            if less:
                dashed(dd, (sx0, sy0), (x1, y1), 4)
            else:
                dd.line([(sx0, sy0), (x1, y1)], fill=ink + (255,), width=4)
            if grow >= 1:
                a = math.atan2(ey - sy0, ex - sx0)
                for s_ in (-1, 1):
                    aa = a + (0 if less else math.pi) + s_ * 0.5
                    bx_, by_ = (ex - 14 * math.cos(a), ey - 14 * math.sin(a)) if less else (ex, ey)
                    dd.line([(bx_, by_), (bx_ + 14 * math.cos(aa), by_ + 14 * math.sin(aa))], fill=ink + (255,), width=4)
            if u < 0.5 and k < 2:  # before opening: plain axis names at the axis ends, clear of both axes
                if k == 0:
                    dd.text((ex - 6, ey + 30), items[0]['label'], font=fl, fill=ink + (255,), anchor='rm')
                else:
                    dd.text((ex + 18, ey + 4), items[1]['label'], font=fl, fill=ink + (255,), anchor='lm')
            elif u >= 0.5 or k >= 2:
                draw_block(im, k)
                dd = ImageDraw.Draw(im)
        if tt >= dot_t and u < 1:
            px, py = ox + (Sw * 0.9 - ox) * 0.18, oy - (oy - Sh * 0.12) * 0.82
            r = 11 * (1 - u)
            if r > 1:
                dd.ellipse([px - r, py - r, px + r, py + r], fill=ink + (255,))
        im = im.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC)
        out = stage.shadowed(im, look.R['card']['shadow'])
        cache[key] = out
        if len(cache) > 6:
            cache.pop(next(iter(cache)))
        return out
    sl = look.LOOK['slide']
    x_end, y_end = e['pos']
    full, pad = draw(t_out - 0.01)
    self.safe_box(e.get('id', 'chart'), *self.opaque_box(full, x_end - pad, y_end - pad), t_in, t_out)
    cache.clear()

    def dyn(tt):
        im, pad = draw(tt)
        x, y = x_end - pad, y_end - pad
        if tt < t_in + sl['in_s']:
            x += (1 - stage.ease_out((tt - t_in) / sl['in_s'])) * (stage.W - x_end + 60)
        if tt >= t_out:
            v = stage.ease_in((tt - t_out) / sl['out_s'])
            if v >= 1:
                return None, 0, 0
            x += v * (stage.W - x_end + 80)
        return im, x, y
    sp = stage.Sprite(e.get('id', 'chart'), None, 0, 0, t_in, 'none', 0, order=55, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('slide_in', t_in)
    for k in range(n):
        self.sound(['piece1', 'piece2', 'piece3'][k % 3], ax_t[k] if k < 2 else sp_t[k])
    self.sound('slide_out', t_out)
