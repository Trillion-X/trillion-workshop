"""typed_scrap (lane ch1 cold opens, round 8): a question typed on a torn scrap of paper, line by line, with a typewriter's rhythm.
Device: the typewriter scrap over the held first frame (text only, no voice). Like events/strip (r3.py ev_strip) the paper lands blank and the
line types on at `cps` with a hand's uneven gaps (look_r3 type.rhythm_spread, word_gap), one real keystroke per character; unlike it the scrap
carries several lines (a carriage return takes `return_s` longer than a key), so a whole question sits on a small scrap instead of a full-width
bar. Paper, so it moves on twos and carries no motion blur; the exit is the scatter event's (events by id).

    {"type": "typed_scrap", "id": "q", "text": "What if the food that feels perfect\\nis leaving you short?", "font": "SpecialElite-Regular.ttf",
     "size": 58, "paper": "white" | "kraft" | "newsprint", "pos": [x, y], "rot": -1.2, "at": s, "chars_per_s": 18, "typing": true, "return_s": 0.3, "exit": "crumple", "out": s}   (exit "crumple": the real crumple and fall of r3.py ev_qcard3)

The speed key is `chars_per_s`, not `cps`: film-qa type-sync takes any `cps` event for one line (its box is len(text) x size x 0.62 wide) and its crop leaves the frame
for a scrap of several lines. `typing: true` makes the check list the element as typed text it did not measure (its look-alike keys) instead of failing.
"""
import bisect

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from overlay import kit, look, stage
from overlay.kit import face
from overlay.look import LOOK3



def ev_typed_scrap(self, e):
    sid = e.get('id', 'scrap')
    fnt = face(e['font'], e['size'])
    lines = e['text'].split('\n')
    text = ''.join(lines)
    asc, desc = fnt.getmetrics()
    lh = int((asc + desc) * e.get('leading', 1.18))
    px, py = int(e['size'] * 0.55), int(e['size'] * 0.4)
    wmax = max(fnt.getlength(l) for l in lines)
    w, h = int(wmax + 2 * px), int(lh * len(lines) + 2 * py)
    self.seed += 1
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).polygon(stage.torn_polygon(w, h, 4, self.seed, step=8), fill=255)
    fill = {'white': stage.rgb('paper_white'), 'kraft': stage.rgb('kraft'), 'newsprint': (228, 224, 214)}[e.get('paper', 'white')]
    base = Image.new('RGBA', (w, h), fill + (255,))
    base = stage.apply_texture(base, {'kraft': 'kraft', 'newsprint': 'newsprint'}.get(e.get('paper', 'white'), 'crumpled'), self.seed, e.get('grain', 0.8))
    # paper thickness: a darker sliver of the same torn shape under the sheet's lower edge, and fibres along the rim (the scrap has a body, not a flat white rectangle)
    rim = np.asarray(mask.filter(ImageFilter.MaxFilter(5)), dtype=np.float32) - np.asarray(mask.filter(ImageFilter.MinFilter(5)), dtype=np.float32)
    arr = np.asarray(base, dtype=np.float32).copy()
    arr[..., :3] *= (1 - 0.12 * np.clip(rim / 255.0, 0, 1))[..., None]
    base = Image.fromarray(arr.astype(np.uint8), 'RGBA')
    base.putalpha(mask)
    ink = kit.col('ink')
    t = self.T(e['at'])
    cps = e['chars_per_s']
    rng = np.random.default_rng(self.seed)
    spread, word_gap = LOOK3['type']['rhythm_spread'], LOOK3['type']['word_gap']
    gaps, line_start = [], set(np.cumsum([len(l) for l in lines])[:-1].tolist())   # characters that begin a new line after the first
    for i in range(1, len(text)):
        g = rng.uniform(1 - spread, 1 + spread) * (word_gap if text[i - 1] == ' ' else 1.0)
        gaps.append(g)
    k = (len(text) - 1 - (e.get('return_s', 0.3) * cps) * len(line_start)) / cps / sum(gaps)   # the line still takes len/cps seconds in all
    keys, now = [t], t
    for i, g in enumerate(gaps, start=1):
        now += k * g + (e.get('return_s', 0.3) if i in line_start else 0.0)
        keys.append(now)
    cache = {}

    def flat_n(n):
        im, left = base.copy(), n
        d = ImageDraw.Draw(im)
        for li, l in enumerate(lines):
            if left <= 0:
                break
            d.text((px, py + li * lh), l[:left], font=fnt, fill=ink + (255,))
            left -= len(l)
        return im

    def img_n(n):
        if n not in cache:
            im = flat_n(n)
            im = im.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC)
            cache[n] = stage.shadowed(im, {'dx': 3, 'dy': 9, 'blur': 12, 'opacity': 0.5})
        return cache[n]
    full, pad = img_n(len(text))
    self.safe_box(sid, *self.opaque_box(full, e['pos'][0] - pad, e['pos'][1] - pad), t)

    t_out = self.T(e['out']) if e.get('exit') == 'crumple' else None
    crumple = self.crumple_frames(flat_n(len(text)), e.get('rot', 0), e.get('crumple_seed', 3), e.get('crumple_s', 0.55)) if t_out is not None else None
    if crumple is not None:
        cx, cy = e['pos'][0] - pad + full.width / 2, e['pos'][1] - pad + full.height / 2
        fall = LOOK3['fall']

    def dyn(tt):
        if crumple is not None and tt >= t_out:   # the real crumple (events/crumple.py, Blender cloth on this face), then the ball falls out of frame
            frames, meta = crumple
            k = int((tt - t_out) * meta['fps'])
            if k < len(frames):
                fr, fpad = frames[k]
                return fr, cx - fr.width / 2, cy - fr.height / 2
            fr, fpad = frames[-1]
            v = tt - t_out - len(frames) / meta['fps']
            ball = fr.rotate(-v * fall['spin_deg_s'], expand=True, resample=Image.BICUBIC)
            dy = 0.5 * fall['gravity_px_s2'] * v * v
            if cy + dy - ball.height / 2 > stage.H:
                return None, 0, 0
            return ball, cx - ball.width / 2 + v * fall['drift_px_s'], cy - ball.height / 2 + dy
        im, p = img_n(bisect.bisect_right(keys, tt + 1e-6))
        return im, e['pos'][0] - p, e['pos'][1] - p
    sp = stage.Sprite(sid, None, 0, 0, t, e.get('intro', 'slam'), 0.12, order=e.get('order', 70), jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    kind = 'type-' + sid   # one keystroke per character as it appears, never one clip laid under the typing
    times = [kt for kt, ch in zip(keys, text) if not ch.isspace()]
    self.extra_sounds[kind] = [{'file': self.clicks_sound(kind, t, times, LOOK3['type']['gain_db']), 'gain_db': 0}]
    self.sound(kind, t)
    if crumple is not None:
        self.sound('crumple', t_out)
        self.sound('fall', t_out + len(crumple[0]) / crumple[1]['fps'])
