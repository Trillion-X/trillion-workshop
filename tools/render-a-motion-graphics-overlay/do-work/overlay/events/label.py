"""The `label` event. Ported from filmcraft/options-ch1/tools-round-2/r2.py:659."""
from PIL import Image, ImageDraw

from overlay import kit, look, stage


# ---------- nutrition-label strip ----------
def ev_label(self, e):
    """A paper label that grows downward: each row (his words) types on at its time with a dotted leader."""
    W_ = e.get('w', 520)
    fr = stage.font(look.R['fonts']['typewriter'], e.get('row_px', 34))
    fh = kit.sf('display_heavy', e.get('head_px', 40))
    rows = e['rows']
    row_h = int(e.get('row_px', 34) * 1.55)
    head_h = int(e.get('head_px', 40) * 1.7) if e.get('head') else 16
    rt = [self.T(r['at']) for r in rows]
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    self.seed += 1
    seed = self.seed
    full_h = head_h + row_h * len(rows) + 24
    paper = Image.new('RGBA', (W_, full_h + 30), stage.rgb('paper_white') + (255,))
    paper = stage.apply_texture(paper, 'crumpled', seed, 0.45)
    cache = {}

    def face(n_rows, grow):
        key = (n_rows, round(grow, 2))
        if key not in cache:
            h = int(head_h + row_h * (n_rows - 1 + grow) + 24) if n_rows else head_h + 24
            im = paper.crop((0, 0, W_, h)).copy()
            m = Image.new('L', im.size, 0)
            pts = stage.torn_polygon(W_, h, 4, seed, step=9)
            ImageDraw.Draw(m).polygon(pts, fill=255)
            im.putalpha(m)
            d = ImageDraw.Draw(im)
            if e.get('head'):
                d.text((22, 14), e['head'], font=fh, fill=kit.col('ink') + (255,))
                d.line([(18, head_h - 6), (W_ - 18, head_h - 6)], fill=kit.col('ink') + (255,), width=6)
            for k in range(n_rows):  # a growing row's text is drawn too: the paper reveals it on the word, not after the grow
                y = head_h + k * row_h + row_h / 2
                d.text((22, y), rows[k]['text'], font=fr, fill=kit.col('ink') + (255,), anchor='lm')
                tw = fr.getlength(rows[k]['text'])
                if rows[k].get('mark'):
                    d.text((W_ - 24, y), rows[k]['mark'], font=fr, fill=kit.col('ink') + (255,), anchor='rm')
                for xx in range(int(22 + tw + 14), W_ - 70, 14):
                    d.ellipse([xx, y + 6, xx + 3, y + 9], fill=kit.col('ink') + (140,))
                d.line([(18, y + row_h / 2), (W_ - 18, y + row_h / 2)], fill=kit.col('ink') + (90,), width=1)
            im = im.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC)
            cache[key] = stage.shadowed(im, look.R['card']['shadow'])
        return cache[key]
    sl = look.LOOK['slide']
    x_end, y_end = e['pos']

    def dyn(tt):
        n_rows = sum(1 for x in rt if x <= tt)
        grow = 1.0
        if n_rows:
            grow = min(1.0, stage.ease_out((tt - rt[n_rows - 1]) / 0.22))
        im, pad = face(n_rows, grow)
        x, y = x_end - pad, y_end - pad
        if tt < t_in + sl['in_s']:
            y -= (1 - stage.ease_out((tt - t_in) / sl['in_s'])) * (y_end + im.height + 40)
        if tt >= t_out:
            v = stage.ease_in((tt - t_out) / sl['out_s'])
            if v >= 1:
                return None, 0, 0
            x += v * (stage.W - x_end + 80)
        return im, x, y
    sp = stage.Sprite(e.get('id', 'label'), None, 0, 0, t_in, 'none', 0, order=55, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('slide_in', t_in)
    for k, x in enumerate(rt):
        self.sound(['piece1', 'piece2', 'piece3'][k % 3], x)
    self.sound('slide_out', t_out)
