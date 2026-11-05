"""stamp_steps (lane ch3): a method said as numbered steps, each step stamped onto a paper slip with a rubber stamp as he
says its verb: the stamp lands big and presses down onto the paper in 0.18 s (stamp impact #635, without the screen
shake), the ink a little uneven like a real stamp (device "numbered steps, said and shown";
filmcraft/options-ch3/TECHNIQUES.md#numbered-steps-stamp).

    {"type": "stamp_steps", "id": "steps", "pos": [x, y], "w": 380, "rot": -2, "at": s, "out": s,
     "steps": [{"n": 1, "text": "question", "at": s}, ...], "exit": "left"}

Red stamp ink on cream paper (one-palette); a paper thump per stamp, a whoosh out.

"layout": "rows" (round 2, synthetic-6d42b2a91588): the whole framework typed on one sheet, every step there from the start
in faint ink so the full method reads, each step inked and stamped as it is reached:
    {"type": "stamp_steps", "layout": "rows", "id": "algo", "pos": [x, y], "w": 560, "rot": 1.5, "at": s, "out": s,
     "title": "MUSK’S ALGORITHM", "credit": "from Walter Isaacson’s biography Elon Musk",
     "steps": [{"text": "1. Question every requirement", "verb": 1, "at": s}, ...],      verb: how many leading words are
                                                                                       the step's verb (stamped in red)
     "note": {"text": "“You may have to add them back later.”", "under": 2, "at": s},  a pencil note written under step 2
     "enter": "right", "exit": "right", "sounds": {"stamp": [kinds...], "note": kind}}
The sheet sits still once it lands (synthetic-469527071d0e); paper pieces on twos carry no motion blur."""
import os
import sys
import numpy as np
from PIL import Image, ImageDraw
from overlay.helpers import paper_pieces as K


def _stamp(n, text, seed, px):
    fnt = K.face('BlackOpsOne-Regular.ttf', px)
    label = f'{n}  {text.upper()}'
    tw = int(fnt.getlength(label))
    w, h = tw + 44, int(px * 1.6)
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([3, 3, w - 4, h - 4], radius=10, outline=K.RED + (255,), width=5)
    d.text((w / 2, h / 2), label, font=fnt, fill=K.RED + (255,), anchor='mm')
    rng = np.random.default_rng(seed)  # uneven ink: speckled gaps, stronger near one edge
    a = np.asarray(im.getchannel('A')).astype(np.float32)
    keep = (rng.uniform(0, 1, a.shape) > 0.16 + 0.12 * np.linspace(0, 1, w)[None, :]).astype(np.float32)
    im.putalpha(Image.fromarray((a * (0.55 + 0.45 * keep)).astype(np.uint8)))
    return im


def _verb_stamp(text, seed, px):
    """A red rubber stamp of a word or two: rounded box, uneven ink (the same stamp as the numbered steps, without a number)."""
    fnt = K.face('BlackOpsOne-Regular.ttf', px)
    tw = int(fnt.getlength(text.upper()))
    w, h = tw + 36, int(px * 1.55)
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([3, 3, w - 4, h - 4], radius=9, outline=K.RED + (255,), width=4)
    d.text((w / 2, h / 2), text.upper(), font=fnt, fill=K.RED + (255,), anchor='mm')
    rng = np.random.default_rng(seed)
    a = np.asarray(im.getchannel('A')).astype(np.float32)
    keep = (rng.uniform(0, 1, a.shape) > 0.14 + 0.1 * np.linspace(0, 1, w)[None, :]).astype(np.float32)
    im.putalpha(Image.fromarray((a * (0.6 + 0.4 * keep)).astype(np.uint8)))
    return im


def _rows(self, e):
    W = e.get('w', 560)
    pad = 34
    title_f = K.face('CourierPrime-Bold.ttf', e.get('title_px', 40))
    credit_f = K.face('SpecialElite-Regular.ttf', e.get('credit_px', 26))
    num_f = K.face('CourierPrime-Bold.ttf', 30)
    rest_f = K.face('SpecialElite-Regular.ttf', e.get('rest_px', 30))
    steps = []
    for k, st in enumerate(e['steps']):
        num, body = st['text'].split('. ', 1)
        words = body.split(' ')
        verb, rest = ' '.join(words[:st.get('verb', 1)]), ' '.join(words[st.get('verb', 1):])
        steps.append({'num': num, 'stamp': _verb_stamp(verb, 90 + k, e.get('stamp_px', 34)), 'rest': rest, 't': self.T(st['at'])})
    row_h = max(st['stamp'].height for st in steps) + int(rest_f.size * 1.35) + 18
    head_h = int(title_f.size * 1.2) + int(credit_f.size * 1.4) + 30
    note = e.get('note')
    note_img = K.hand(note['text'], 'Kalam-Bold.ttf', e.get('note_px', 28), colour=(70, 88, 120)) if note else None
    if note_img is not None and note_img.width > W - 2 * pad:
        raise SystemExit(f'{self.id}: the note is {note_img.width}px wide; the sheet fits {W - 2 * pad}px')
    note_h = note_img.height - 6 if note else 0
    tops = [pad + head_h + k * row_h + (note_h if note and k >= note['under'] else 0) for k in range(len(steps))]
    H = tops[-1] + row_h + pad
    for txt, f in ((e['title'], title_f), (e['credit'], credit_f)):
        if f.getlength(txt) > W - 2 * pad:
            raise SystemExit(f'{self.id}: "{txt}" is {f.getlength(txt):.0f}px wide; the sheet fits {W - 2 * pad}px')
    self.seed += 1
    sheet = K.paper(W, H, 'white', self.seed, edge='straight')
    d = ImageDraw.Draw(sheet)
    d.text((pad, pad), e['title'], font=title_f, fill=K.INK + (255,))
    d.text((pad, pad + int(title_f.size * 1.2)), e['credit'], font=credit_f, fill=(110, 108, 102, 255))
    y0 = pad + head_h
    d.line([(pad, y0 - 14), (W - pad, y0 - 14)], fill=(200, 196, 186, 255), width=2)

    def row_layer(k, ink):
        """Step k typed in ink of alpha `ink` (faint before it is reached)."""
        st = steps[k]
        lay = Image.new('RGBA', (W, row_h), (0, 0, 0, 0))
        dl = ImageDraw.Draw(lay)
        c = K.INK + (int(255 * ink),)
        dl.ellipse([pad, 6, pad + 40, 46], outline=c, width=3)
        dl.text((pad + 20, 26), st['num'], font=num_f, fill=c, anchor='mm')
        sx = pad + 60
        verb_y = 2
        if ink < 1:  # before it is reached the verb shows faint in ink, where the stamp will land
            g = np.asarray(st['stamp'].getchannel('A')) > 0
            ghost = np.zeros((st['stamp'].height, st['stamp'].width, 4), np.uint8)
            ghost[..., :3] = K.INK
            ghost[..., 3] = (g * 255 * ink * 0.9).astype(np.uint8)
            lay.alpha_composite(Image.fromarray(ghost, 'RGBA'), (sx, verb_y))
        dl.text((sx + 2, verb_y + st['stamp'].height + 4), st['rest'], font=rest_f, fill=c)
        return lay
    faint = [row_layer(k, 0.26) for k in range(len(steps))]
    full = [row_layer(k, 1.0) for k in range(len(steps))]
    t_note = self.T(note['at']) if note else None
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    cache = {}

    def picture(tt):
        state = tuple(round(min(1.0, (tt - st['t']) / 0.18), 2) if tt >= st['t'] else -1 for st in steps)
        fn = 0.0 if t_note is None or tt < t_note else round(min(1.0, (tt - t_note) / 0.9), 2)
        key = (state, fn)
        if key in cache:
            return cache[key]
        im = sheet.copy()
        for k, (st, f) in enumerate(zip(steps, state)):
            y = tops[k]
            im.alpha_composite(full[k] if f >= 0 else faint[k], (0, y))
            if f >= 0:
                sc = 1.25 - 0.25 * K.ease_in(f)  # lands big, presses down to size
                s2 = st['stamp'].rotate([-2, 1.5, -1, 2, -1.5][k % 5], expand=True, resample=Image.BICUBIC)
                s2 = s2.resize((max(1, int(s2.width * sc)), max(1, int(s2.height * sc))), Image.BICUBIC)
                if f < 1:
                    s2.putalpha(s2.getchannel('A').point(lambda v: int(v * (0.4 + 0.6 * f))))
                cx, cy = pad + 60 + st['stamp'].width / 2, y + 2 + st['stamp'].height / 2
                im.alpha_composite(s2, (int(cx - s2.width / 2), int(cy - s2.height / 2)))
        if fn > 0:  # the pencil note, written in beside the step it belongs to
            ny = tops[note['under'] - 1] + row_h - 10  # in the space kept under its step
            im.alpha_composite(K.reveal(note_img, fn), (pad + 56, ny))
        out = K.shadow(im.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC))[0]
        cache[key] = out
        return out
    x, y = e['pos']
    K.moving(self, e.get('id', 'steps'), picture, x, y, t_in, t_out, enter=e.get('enter', 'right'), exit=e.get('exit', 'right'),
             order=60, drift=False, paper_exits=True)
    snd = e.get('sounds', {})
    stamps = snd.get('stamp', ['thump'])
    self.sound('slide_in', t_in)
    for k, st in enumerate(steps):
        self.sound(stamps[k % len(stamps)], st['t'] + 0.15)
    if note:
        self.sound(snd.get('note', 'marker'), t_note)
    K.leave_sound(self, e.get('exit', 'right'), t_out)


def ev_stamp_steps(self, e):
    if e.get('layout') == 'rows':
        return _rows(self, e)
    W = e.get('w', 380)
    stamps = [_stamp(s['n'], s['text'], 70 + k, e.get('px', 50)) for k, s in enumerate(e['steps'])]
    gap = 26
    H = 40 + sum(st.height + gap for st in stamps) + 14
    self.seed += 1
    slip = K.paper(W, H, 'cream', self.seed, edge='torn')
    times = [self.T(s['at']) for s in e['steps']]
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    rots = e.get('rots', [-3, 2, -1])
    cache = {}

    def picture(tt):
        state = tuple(round(min(1.0, (tt - ts) / 0.18), 2) if tt >= ts else -1 for ts in times)
        if state in cache:
            return cache[state]
        im = slip.copy()
        y = 40
        for k, (st, f) in enumerate(zip(stamps, state)):
            if f >= 0:
                sc = 1.25 - 0.25 * K.ease_in(f)  # lands big, presses down to size
                s2 = st.rotate(rots[k % len(rots)], expand=True, resample=Image.BICUBIC)
                s2 = s2.resize((max(1, int(s2.width * sc)), max(1, int(s2.height * sc))), Image.BICUBIC)
                if f < 1:
                    a = s2.getchannel('A').point(lambda v: int(v * (0.4 + 0.6 * f)))
                    s2.putalpha(a)
                im.alpha_composite(s2, (int(W / 2 - s2.width / 2), int(y + st.height / 2 - s2.height / 2)))
            y += st.height + gap
        out = K.shadow(im.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC))[0]
        cache[state] = out
        return out
    x, y = e['pos']
    K.moving(self, e.get('id', 'steps'), picture, x, y, t_in, t_out, enter=e.get('enter', 'left'), exit=e.get('exit', 'left'), order=60,
             paper_exits=True)
    self.sound('slide_in', t_in)
    for ts in times:
        self.sound('thump', ts + 0.15)
    K.leave_sound(self, e.get('exit', 'left'), t_out)
