"""question_ledger (round 8, the narrator's analysis beat, option B): the advice-ledger device (DEVICES.md line
183: a written list of what was done, reviewed one line at a time) turned on his question, then "rule, then test" (device line
231: name the rule, then apply it) with a rubber stamp for the verdict (stamp impact #635, library/techniques/INDEX.md:13).

A ruled index card is headed with his question. Each thing he asked is written in marker on his word, and a red bracket down the
left edge grows with every row. On "bigger" the card itself grows taller and a red "?" is written at the foot of the bracket.
The first row is struck through when the ice cream "never gets made". The ledger leaves; one small card lands with the one
question written on it, and a red stamp slams onto it on the question's first word.

    {"type": "question_ledger", "id": "led", "right": 1840, "top": 230, "w": 540, "rot": 1.5, "at": [word, off],
     "title": "the host's question", "rows": [{"text": "ice cream", "at": [word, off]}, ...],
     "grow_at": [word, off], "grow_rows": 2, "strike_row": 0, "strike_at": [word, off], "out": [word, off],
     "test": {"lines": ["Can food he loves eating", ...], "at": [word, off], "stamp": "THE TEST", "stamp_at": [word, off],
              "top": 330, "out": [word, off]}}

Ink on white (synthetic-4b111b631333). Every card sits right of his face (synthetic-73042df8cd3b)."""
import os
import sys
import numpy as np
from PIL import Image, ImageDraw
from overlay.kit import ease_out
from overlay.helpers import paper_pieces as K
from overlay.helpers.writing_sounds import write_sound

FACE = 'Kalam-Bold.ttf'


def _stamp(text, px, seed):
    """A red rubber stamp: rounded box, uneven ink."""
    fnt = K.face('BlackOpsOne-Regular.ttf', px)
    w, h = int(fnt.getlength(text.upper())) + 44, int(px * 1.6)
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([3, 3, w - 4, h - 4], radius=10, outline=K.RED + (255,), width=5)
    d.text((w / 2, h / 2), text.upper(), font=fnt, fill=K.RED + (255,), anchor='mm')
    rng = np.random.default_rng(seed)
    a = np.asarray(im.getchannel('A')).astype(np.float32)
    keep = (rng.uniform(0, 1, a.shape) > 0.16 + 0.12 * np.linspace(0, 1, w)[None, :]).astype(np.float32)
    im.putalpha(Image.fromarray((a * (0.55 + 0.45 * keep)).astype(np.uint8)))
    return im


def _bracket(h, size):
    """A red bracket h tall with an arrow tip at its foot, in marker."""
    w = int(size * 0.5)
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.line([(w - 6, 6), (8, 14), (8, h - 18), (w - 6, h - 8)], fill=K.RED + (255,), width=max(5, int(size * 0.1)), joint='curve')
    return im


def _ledger(self, e, sid):
    size = e.get('size', 42)
    fnt = K.face(FACE, size)
    asc, desc = fnt.getmetrics()
    lh = int((asc + desc) * 1.15)
    pad, left = 34, 66
    w = e.get('w', 540)
    rows, n_grow = e['rows'], e.get('grow_rows', 2)
    h0 = pad + lh * (len(rows) + 1) + pad
    h1 = h0 + lh * n_grow
    title = K.hand(e['title'], FACE, int(size * 0.8), K.RED)
    self.seed += 1
    paper = K.paper(w, h1, 'index', self.seed, edge='straight', rules=(pad + lh - int(desc * 0.4), lh))
    ink = [K.hand(r['text'], FACE, size) for r in rows]
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    t_row = [self.T(r['at']) for r in rows]
    t_grow = self.T(e['grow_at'])
    t_strike = self.T(e['strike_at'])
    strike_row = e.get('strike_row', 0)
    bracket_full = _bracket(h1 - 2 * pad - lh // 2, size)
    q = K.hand('?', 'PermanentMarker-Regular.ttf', int(size * 1.7), K.RED)
    rot = e.get('rot', 0)
    cache = {}

    def picture(tt):
        n_rows = sum(1 for t in t_row if tt >= t)
        f_row = [min(1.0, max(0.0, (tt - t) / 0.5)) for t in t_row]
        g = ease_out(min(max((tt - t_grow) / 0.6, 0.0), 1.0))
        f_q = min(max((tt - t_grow - 0.4) / 0.4, 0.0), 1.0)
        f_st = min(max((tt - t_strike) / 0.4, 0.0), 1.0)
        key = (tuple(round(f, 1) for f in f_row), round(g, 2), round(f_q, 1), round(f_st, 1))
        if key not in cache:
            h = int(h0 + (h1 - h0) * g)
            im = paper.crop((0, 0, w, h))
            im.alpha_composite(title, (left, pad - 4))
            for i, (ink_i, f) in enumerate(zip(ink, f_row)):
                if f > 0:
                    im.alpha_composite(K.reveal(ink_i, f), (left, pad + lh * (i + 1)))
            if f_st > 0:  # the strike through the struck row
                y = pad + lh * (strike_row + 1) + int(lh * 0.55)
                x1 = left + int((ink[strike_row].width) * f_st)
                ImageDraw.Draw(im).line([(left - 6, y + 4), (x1 + 6, y - 4)], fill=K.RED + (255,), width=7)
            last = max([i for i, f in enumerate(f_row) if f > 0], default=-1)
            if last >= 0:  # the bracket grows with the rows, and with the card
                bh = pad + lh * (last + 1) + lh - (pad + lh) - 6
                if g > 0:
                    bh += int(lh * n_grow * g)
                bh = max(bh, 40)
                b = bracket_full.crop((0, 0, bracket_full.width, min(bh, bracket_full.height)))
                im.alpha_composite(b, (14, pad + lh + 8))
            if f_q > 0:
                im.alpha_composite(K.reveal(q, f_q), (left, pad + lh * (len(rows) + 1) - 6))
            im = im.rotate(-rot, expand=True, resample=Image.BICUBIC)
            cache.clear()
            cache[key] = K.shadow(im)[0]
        return cache[key]
    pad_s = K.shadow(Image.new('RGBA', (4, 4)))[1]  # the shadow's margin round the picture
    x, y = e['right'] - w - pad_s, e['top'] - pad_s
    K.moving(self, sid, picture, x, y, t_in, t_out, enter=e.get('enter', 'right'), exit=e.get('exit', 'right'), order=e.get('order', 60))
    self.sound('slide_in', t_in)
    for i, t in enumerate(t_row):
        write_sound(self, i, t)
    write_sound(self, len(t_row), t_grow + 0.4)
    write_sound(self, len(t_row) + 1, t_strike)
    self.sound('slide_out', t_out)


def _test_card(self, e, sid):
    t = e['test']
    size = t.get('size', 46)
    body = K.hand('\n'.join(t['lines']), FACE, size)
    pad = 36
    stamp = _stamp(t['stamp'], int(size * 1.0), 3)
    band = stamp.height + 30  # a clear strip under the words, where the stamp lands (it never covers the question)
    w, h = max(body.width + 2 * pad, stamp.width + 2 * pad), body.height + 2 * pad + band
    self.seed += 1
    card = K.paper(w, h, 'white', self.seed, edge='torn')
    card.alpha_composite(body, (pad, pad))
    t_in, t_out, t_st = self.T(t['at']), self.T(t['out']), self.T(t['stamp_at'])
    rot, srot = t.get('rot', -1.5), t.get('stamp_rot', -7)
    m = 90  # clear paper round the card, so the slamming stamp (1.3x, turned) never meets the picture's edge
    anchor = (m + w - int(stamp.width * 0.58) - 10, m + h - band // 2 - 4)  # the stamp's centre, in the strip under the words
    cache = {}

    def picture(tt):
        u = min(max((tt - t_st) / 0.18, 0.0), 1.0)
        key = round(u, 2) if tt >= t_st else -1
        if key not in cache:
            im = Image.new('RGBA', (w + 2 * m, h + 2 * m), (0, 0, 0, 0))
            im.alpha_composite(card, (m, m))
            if key >= 0:
                s = 1.3 - 0.3 * ease_out(u)
                st = stamp.rotate(srot, expand=True, resample=Image.BICUBIC)
                st = st.resize((int(st.width * s), int(st.height * s)), Image.LANCZOS)
                st.putalpha(st.getchannel('A').point(lambda v, a=min(1.0, u * 3): int(v * a)))
                im.alpha_composite(st, (anchor[0] - st.width // 2, anchor[1] - st.height // 2))
            im = im.rotate(-rot, expand=True, resample=Image.BICUBIC)
            cache.clear()
            cache[key] = K.shadow(im)[0]
        return cache[key]
    pad_s = K.shadow(Image.new('RGBA', (4, 4)))[1]
    x, y = e['right'] - w - m - pad_s, t['top'] - m - pad_s
    K.moving(self, sid + '-test', picture, x, y, t_in, t_out, enter='right', exit='right', order=e.get('order', 60) + 3, check=False)
    self.safe_box(sid + '-test', e['right'] - w, t['top'], e['right'], t['top'] + h, t_in, t_out)
    self.sound('slide_in', t_in)
    self.sound('paper', t_st)
    self.sound('slide_out', t_out)


def ev_question_ledger(self, e):
    sid = e.get('id', 'led')
    _ledger(self, e, sid)
    if e.get('test'):
        _test_card(self, e, sid)
