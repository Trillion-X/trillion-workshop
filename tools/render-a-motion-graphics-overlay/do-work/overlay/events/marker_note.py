"""marker_note (lane ch3): a handwritten note on an index card, with a proofreader's insertion: a red caret is drawn at the
gap and the missing words are written in red beside it, on the words he says (technique: insertion caret, a cousin of
Strikethrough Replace #110 in video-edit-techniques; filmcraft/options-ch3/TECHNIQUES.md#insertion-caret). The same card can come back
later with the insertion already made (a callback).

    {"type": "marker_note", "id": "mission", "pos": [x, y], "w": 470, "rot": -3, "at": s, "out": s,
     "lines": ["nutrient dense", "per calorie", "per bite"], "face": "Kalam-Bold.ttf", "size": 44,
     "insert": {"text": "maximum enjoyment", "at": s, "write_s": 0.9, "done": false},
     "underline_at": [s, ...],                 red marker underline under the inserted words, drawn on each time
     "enter": "left", "exit": "left"}

The card's words are all on it from its first frame (text-ready-not-late); only the insertion is written on. Ink on a white
card (text-colour-contrast); the card sits on the dark wood cabinets, away from his face (clear-of-face)."""
import os
import sys
from PIL import Image, ImageDraw
from overlay.helpers import paper_pieces as K


def _caret(size):
    im = Image.new('RGBA', (int(size * 0.8), int(size * 0.7)), (0, 0, 0, 0))
    w, h = im.size
    ImageDraw.Draw(im).line([(4, h - 4), (w / 2, 4), (w - 4, h - 4)], fill=K.RED + (255,), width=max(4, int(size * 0.11)), joint='curve')
    return im


def ev_marker_note(self, e):
    sid = e.get('id', 'note')
    size = e.get('size', 44)
    body = K.hand('\n'.join(e['lines']), e.get('face', 'Kalam-Bold.ttf'), size)
    ins = e.get('insert')
    fnt = K.face(e.get('face', 'Kalam-Bold.ttf'), size)
    asc, desc = fnt.getmetrics()
    lh = int((asc + desc) * 1.15)  # K.hand's line height
    pad = 34
    w = e.get('w', max(body.width + 2 * pad, 420))
    extra = lh + 10 if ins else 0
    h = body.height + 2 * pad + extra
    self.seed += 1
    base = K.paper(w, h, 'index', self.seed, edge='straight', rules=(pad + 4 + lh - int(desc * 0.4), lh))
    base.alpha_composite(body, (pad, pad))
    ink_red = caret = under = None
    if ins:
        ink_red = K.hand(ins['text'], e.get('insert_face', 'PermanentMarker-Regular.ttf'), int(size * 0.9), K.RED)
        caret = _caret(size)
        cy = pad + body.height + 2
        cx = pad
        tx = cx + caret.width + 10
        under = Image.new('RGBA', (ink_red.width, 14), (0, 0, 0, 0))
        ImageDraw.Draw(under).line([(2, 9), (ink_red.width - 4, 5)], fill=K.RED + (255,), width=5)
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    t_ins = self.T(ins['at']) if ins and not ins.get('done') else None
    write_s = ins.get('write_s', 0.9) if ins else 0
    unders = [self.T(u) for u in e.get('underline_at', [])]
    rot = e.get('rot', 0)
    cache = {}

    def picture(tt):
        if ins and ins.get('done'):
            f_ins = 1.0
        elif t_ins is None or tt < t_ins:
            f_ins = -1.0
        else:
            f_ins = min(1.0, (tt - t_ins) / write_s)
        f_un = 0.0
        for u in unders:
            if tt >= u:
                f_un = min(1.0, (tt - u) / 0.35)
        key = (round(f_ins, 2), round(f_un, 2))
        if key not in cache:
            im = base.copy()
            if f_ins >= 0:
                im.alpha_composite(K.reveal(caret, min(1.0, f_ins * 4)), (cx, cy))
                im.alpha_composite(K.reveal(ink_red, max(0.0, (f_ins - 0.2) / 0.8)), (tx, cy - 6))
            if f_un > 0:
                im.alpha_composite(K.reveal(under, f_un), (tx, cy + ink_red.height - 2))
            im = im.rotate(-rot, expand=True, resample=Image.BICUBIC)
            cache[key] = K.shadow(im)[0]
        return cache[key]
    x, y = e['pos']
    K.moving(self, sid, picture, x, y, t_in, t_out, enter=e.get('enter', 'left'), exit=e.get('exit', 'left'), order=e.get('order', 60))
    self.sound('slide_in', t_in)
    if t_ins is not None:
        self.sound('marker_long', t_ins)
    for u in unders:
        self.sound('marker', u)
    self.sound('slide_out', t_out)
