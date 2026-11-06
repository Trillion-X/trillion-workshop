"""The `strip` event. Ported from filmcraft/options-ch1/tools-round-3/r3.py:400."""
import bisect
import numpy as np
from PIL import Image, ImageDraw

from overlay import kit, look, stage


# ---------- one line on a torn strip ----------
def ev_strip(self, e):
    """Text on a strip: paper (white), kraft, newsprint or tape (black label tape, light letters). Types on at cps
    when e.cps is set, else the whole line lands at once (synthetic-9710181698cd). Typing has a hand's rhythm: each gap
    between keys varies (LOOK3 type.rhythm_spread) and a word break takes longer (type.word_gap), scaled so the line
    still takes len/cps seconds; the picture and the keystroke sounds use the same key times."""
    fnt = kit.face(e['font'], e['size'])
    bb = fnt.getbbox(e['text'])
    px, py = int(e['size'] * 0.45), int(e['size'] * 0.3)
    w, h = int(bb[2] - bb[0] + 2 * px), int(bb[3] - bb[1] + 2 * py)
    self.seed += 1
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).polygon(stage.torn_polygon(w, h, 3 if e['paper'] != 'tape' else 1, self.seed, step=8), fill=255)
    fill = {'white': stage.rgb('paper_white'), 'kraft': stage.rgb('kraft'), 'newsprint': (228, 224, 214), 'tape': (24, 24, 26)}[e['paper']]
    base = Image.new('RGBA', (w, h), fill + (255,))
    base = stage.apply_texture(base, {'kraft': 'kraft', 'newsprint': 'newsprint'}.get(e['paper'], 'crumpled'), self.seed, 0.45)
    base.putalpha(mask)
    inkc = (240, 240, 236) if e['paper'] == 'tape' else kit.col('ink')
    t = self.T(e['at'])
    cps = e.get('cps')
    cache = {}
    if cps:
        rng = np.random.default_rng(self.seed)
        gaps = [rng.uniform(1 - look.LOOK3['type']['rhythm_spread'], 1 + look.LOOK3['type']['rhythm_spread'])
                * (look.LOOK3['type']['word_gap'] if e['text'][i - 1] == ' ' else 1.0) for i in range(1, len(e['text']))]
        k = (len(e['text']) - 1) / cps / sum(gaps) if gaps else 0
        keys = [t] + [t + k * g for g in np.cumsum(gaps)]  # time each character appears

    def img_n(n):
        if n not in cache:
            im = base.copy()
            ImageDraw.Draw(im).text((px - bb[0], py - bb[1]), e['text'][:n], font=fnt, fill=inkc + (255,))
            im = im.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC)
            cache[n] = stage.shadowed(im, {'dx': 2, 'dy': 6, 'blur': 10, 'opacity': 0.35})
        return cache[n]
    full, pad = img_n(len(e['text']))
    self.safe_box(e.get('id', 'strip'), *self.opaque_box(full, e['pos'][0] - pad, e['pos'][1] - pad), t)

    def dyn(tt):
        n = len(e['text']) if not cps else bisect.bisect_right(keys, tt + 1e-6)
        im, p = img_n(n)
        return im, e['pos'][0] - p, e['pos'][1] - p
    sp = stage.Sprite(e.get('id', 'strip'), None, 0, 0, t, e.get('intro', 'slam'), 0.12, order=e.get('order', 70), jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    if cps:  # one keystroke per character as it appears (synthetic-99c2095c6735), never one clip laid under the typing
        kind = 'type-' + e.get('id', 'strip')
        times = [kt for kt, ch in zip(keys, e['text']) if not ch.isspace()]
        self.extra_sounds[kind] = [{'file': self.clicks_sound(kind, t, times, look.LOOK3['type']['gain_db']), 'gain_db': 0}]
        self.sound(kind, t)
    else:
        self.sound(e.get('sound', 'piece2'), t)
