"""The `chart` event. Ported from filmcraft/options-ch1/tools-round-2/r2.py:536."""
import math
from PIL import Image, ImageDraw

from overlay import kit, look, stage


# ---------- the full-range chart ----------
def ev_chart(self, e):
    """Graph-paper card. Two axes (x: calories, y: protein) draw on their words with a dot in the
    low-calorie, high-protein corner; on e.open_at the axes swing out into spokes, one label per spoke on its time."""
    S = e.get('size', 600)
    self.seed += 1
    card = Image.new('RGBA', (S, S), (247, 247, 241, 255))
    d = ImageDraw.Draw(card)
    for k in range(0, S, 24):
        d.line([(k, 0), (k, S)], fill=kit.col('grid') + (110,), width=1)
        d.line([(0, k), (S, k)], fill=kit.col('grid') + (110,), width=1)
    card = stage.apply_texture(card, 'sheet', self.seed, 0.3)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).polygon(stage.torn_polygon(S, S, 5, self.seed, step=9), fill=255)
    card.putalpha(mask)
    ink = kit.col('ink')
    fl = kit.sf('text_semibold', e.get('label_px', 26))
    cx, cy = S / 2, S / 2 + 10
    R0 = S * 0.31
    ox, oy = S * 0.16, S * 0.84  # 2-D origin
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    ax_t = [self.T(x) for x in e['axis_at']]  # calories, protein
    dot_t = self.T(e['dot_at'])
    t_open = self.T(e['open_at'])
    spokes = e['spokes']  # [{'label':..,'at':..}] first two are calories, protein
    sp_t = [self.T(s['at']) if 'at' in s else ax_t[k] for k, s in enumerate(spokes)]
    n = len(spokes)
    cache = {}

    def draw(tt):
        key = round(tt * stage.FPS / stage.HOLD)
        if key in cache:
            return cache[key]
        im = card.copy()
        d = ImageDraw.Draw(im)
        u = stage.ease_out((tt - t_open) / 0.6) if tt >= t_open else 0.0
        # targets: spoke k at angle -90 + k*360/n degrees, from centre
        for k in range(n):
            if k >= 2 and tt < sp_t[k]:
                continue
            if k < 2 and tt < ax_t[k]:
                continue
            grow = stage.ease_out((tt - (ax_t[k] if k < 2 else sp_t[k])) / 0.3)
            ang = math.radians(-90 + k * 360 / n)
            tx, ty = cx + R0 * math.cos(ang), cy + R0 * math.sin(ang)
            if k == 0:
                sx0, sy0, ex, ey = ox, oy, S * 0.9, oy
            elif k == 1:
                sx0, sy0, ex, ey = ox, oy, ox, S * 0.12
            else:
                sx0, sy0, ex, ey = cx, cy, tx, ty
            if k < 2:
                sx0 = sx0 + (cx - sx0) * u; sy0 = sy0 + (cy - sy0) * u
                ex = ex + (tx - ex) * u; ey = ey + (ty - ey) * u
            x1, y1 = sx0 + (ex - sx0) * grow, sy0 + (ey - sy0) * grow
            d.line([(sx0, sy0), (x1, y1)], fill=ink + (255,), width=4)
            if grow >= 1:
                a = math.atan2(ey - sy0, ex - sx0)
                for s_ in (-1, 1):
                    aa = a + math.pi + s_ * 0.45
                    d.line([(ex, ey), (ex + 14 * math.cos(aa), ey + 14 * math.sin(aa))], fill=ink + (255,), width=4)
            # the label shows on its word, while its line is still drawing
            lab = spokes[k]['label']
            lw = fl.getlength(lab)
            if k == 0 and u < 0.5:
                lx, ly, anc = ex - lw / 2 - 6, ey + 28, 'mm'
                lx = ex - 6
                d.text((lx, ly), lab, font=fl, fill=ink + (255,), anchor='rm')
            elif k == 1 and u < 0.5:
                d.text((ex + 14, ey + 6), lab, font=fl, fill=ink + (255,), anchor='lm')
            else:
                ang2 = math.atan2(ey - cy, ex - cx)
                lx = ex + 30 * math.cos(ang2)
                ly = ey + 30 * math.sin(ang2)
                anc = 'lm' if math.cos(ang2) > 0.3 else ('rm' if math.cos(ang2) < -0.3 else ('mb' if math.sin(ang2) < 0 else 'mt'))
                lx = min(max(lx, 8 if anc != 'rm' else lw + 8), S - 8 if anc != 'lm' else S - lw - 8)
                d.text((lx, ly), lab, font=fl, fill=ink + (255,), anchor=anc)
        # the dot: low calories (near origin on x), high protein (far up y); after opening it is a filled shape
        if tt >= dot_t and u < 1:
            px, py = ox + (S * 0.9 - ox) * 0.18, oy - (oy - S * 0.12) * 0.82
            r = 11 * (1 - u)
            if r > 1:
                d.ellipse([px - r, py - r, px + r, py + r], fill=ink + (255,))
        if u > 0:
            shown = [k for k in range(n) if (k < 2 or tt >= sp_t[k] + 0.3)]
            if len(shown) >= 3:
                pts = []
                for k in shown:
                    ang = math.radians(-90 + k * 360 / n)
                    rr = R0 * e['spokes'][k].get('fill', 0.7) * min(1.0, u)
                    pts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang)))
                ov = Image.new('RGBA', im.size, (0, 0, 0, 0))
                ImageDraw.Draw(ov).polygon(pts, fill=ink + (38,), outline=ink + (200,))
                im.alpha_composite(ov)
        im = im.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC)
        out = stage.shadowed(im, look.R['card']['shadow'])
        cache[key] = out
        if len(cache) > 6:
            cache.pop(next(iter(cache)))
        return out
    sl = look.LOOK['slide']
    x_end, y_end = e['pos']

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
    for k, s in enumerate(spokes):
        self.sound(['piece1', 'piece2', 'piece3'][k % 3], ax_t[k] if k < 2 else sp_t[k])
    self.sound('slide_out', t_out)
