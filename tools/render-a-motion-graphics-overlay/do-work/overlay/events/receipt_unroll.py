"""receipt_unroll (lane ch3): a list printed on a till-receipt strip that unrolls downward beside him, one line after
another, the roll visible at the bottom edge while it unrolls; how long it gets is the point. It leaves by rolling back up
and out of the top of the frame (technique: receipt unroll, after Image Unroll #566 in video-edit-techniques;
filmcraft/options-ch3/TECHNIQUES.md#receipt-unroll).

    {"type": "receipt_unroll", "id": "receipt", "pos": [x, y], "w": 360, "title": "IMPOSSIBLE BURGER",
     "items": ["WATER", ...], "footer": "label text, amazon.com, 21 Oct 2026",
     "at": s, "unroll_s": 5.0, "out": s}

Ink on warm white thermal paper; monospace receipt face (Cutive Mono, OFL). One rustle per second of unrolling.

Round-2 keys (absent: round 1 as it was):
    "heading": "2019 RECIPE"        a second, smaller printed line under the title
    "marks": [{"text": "METHYLCELLULOSE", "at": s, "colour": "red"}, ...]
                                    a real highlighter stroke (kit highlight_onto) over every printed line of that item,
                                    written on left to right in about 0.4 s a line, multiplied into the paper
    "ease": "quick"                 the unroll runs power2.out (Image Unroll #566) and lands, no long slow finish
    "drift": false                  once unrolled it sits still (documents-settle-still)
    "sound": "print"                one printed-receipt sound for the whole unroll (m03_print) and a felt-tip stroke
                                    per mark, instead of a rustle every second"""
import os
import sys
import numpy as np
from PIL import Image, ImageDraw
from overlay import stage
from overlay.helpers import paper_pieces as K


def ev_receipt_unroll(self, e):
    w = e['w']
    fnt = K.face(e.get('face', 'CutiveMono-Regular.ttf'), e.get('size', 23))
    ftitle = K.face('CourierPrime-Bold.ttf', e.get('title_px', 28))
    asc, desc = fnt.getmetrics()
    lh = int((asc + desc) * 1.12)
    pad = 22
    lines, item_of = [], []
    for k, it in enumerate(e['items']):  # wrap long items at the strip's width
        cur = ''
        for wd in it.split(' '):
            trial = cur + ' ' + wd if cur else wd  # a continuation line keeps its indent
            if cur and fnt.getlength(trial) > w - 2 * pad:
                lines.append(cur)
                item_of.append(k)
                cur = '  ' + wd
            else:
                cur = trial
        lines.append(cur)
        item_of.append(k)
    th = ftitle.getbbox(e['title'])[3] + 20
    fhead = K.face('CourierPrime-Bold.ttf', e.get('heading_px', 24)) if e.get('heading') else None
    hh = fhead.getbbox(e['heading'])[3] + 12 if fhead else 0
    foot = K.hand(e['footer'], 'CutiveMono-Regular.ttf', 16) if e.get('footer') else None
    h = pad + th + hh + 14 + lh * len(lines) + 16 + (foot.height + 10 if foot else 0) + pad
    strip = Image.new('RGBA', (w, h), (247, 245, 238, 255))
    strip = stage.apply_texture(strip, 'sheet', 9, 0.18)
    d = ImageDraw.Draw(strip)
    d.text((w / 2, pad), e['title'], font=ftitle, fill=K.INK + (255,), anchor='ma')
    y = pad + th
    if fhead:
        d.text((w / 2, y - 6), e['heading'], font=fhead, fill=K.INK + (255,), anchor='ma')
        y += hh
    d.line([(pad, y), (w - pad, y)], fill=K.INK + (255,), width=2)
    y += 14
    line_y = []
    for ln in lines:
        d.text((pad, y), ln, font=fnt, fill=K.INK + (255,))
        line_y.append(y)
        y += lh
    d.line([(pad, y + 6), (w - pad, y + 6)], fill=K.INK + (160,), width=1)
    if foot:
        strip.alpha_composite(foot, ((w - foot.width) // 2, y + 16))
    # zig-zag tear at the bottom, as a receipt torn off the printer
    m = Image.new('L', (w, h), 255)
    zz = [(x, h - (8 if (x // 12) % 2 else 0)) for x in range(0, w + 12, 12)]
    ImageDraw.Draw(m).polygon([(0, h)] + zz + [(w, h)], fill=0)
    strip.putalpha(m)
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    dur = e.get('unroll_s', 5.0)
    marks = []
    for k, m in enumerate(e.get('marks', [])):
        item = e['items'].index(m['text'])
        boxes = [(pad - 8, line_y[j] - 3, pad + 10 + int(fnt.getlength(lines[j].rstrip())), line_y[j] + asc + desc + 2)
                 for j in range(len(lines)) if item_of[j] == item]
        marks.append((boxes, m.get('colour', 'red'), self.T(m['at']), k + 2))
    roll_h = 26
    yy = np.linspace(-1, 1, roll_h)[:, None]
    roll_shade = (1 - 0.45 * yy ** 2)  # a cylinder: lighter in the middle of the roll
    roll = np.dstack([np.repeat((np.array([238, 235, 226])[None, :] * roll_shade)[:, None, :], w, 1)[..., c] for c in range(3)]
                     + [np.full((roll_h, w), 255)]).astype(np.uint8)
    roll_im = Image.fromarray(roll, 'RGBA')
    cache = {}

    quick = e.get('ease') == 'quick'

    def shown(tt):
        if tt < t_out:
            u = min(1.0, max(0.0, (tt - t_in) / dur))
            if quick:
                return 1 - (1 - u) ** 2
            return K.ease_out(u) if u < 1 else 1.0
        return max(0.0, 1 - K.ease_in(min(1.0, (tt - t_out) / 0.6)))

    def marked(fr):
        if not any(fr):
            return strip
        im = strip.copy()
        for (boxes, col, _, seed), f in zip(marks, fr):
            left = f * len(boxes)  # one hand: line after line, left to right
            for b in boxes:
                if left <= 0:
                    break
                K.highlight_onto(im, b, col, min(1.0, left), seed)
                left -= 1
        return im

    def picture(tt):
        f = shown(tt)
        fr = tuple(round(min(1.0, max(0.0, (tt - at) / (0.4 * len(b)))), 2) for b, _, at, _ in marks)
        key = (200 if f >= 1 else min(199, round(f * 200)), fr)  # fully unrolled has its own picture (no roll at the foot)
        if key in cache:
            return cache[key]
        vis = max(roll_h, int(h * f))
        im = Image.new('RGBA', (w, vis + roll_h // 2), (0, 0, 0, 0))
        im.alpha_composite(marked(fr).crop((0, 0, w, vis)), (0, 0))
        if f < 1:
            im.alpha_composite(roll_im, (0, vis - roll_h // 2))
        out = K.shadow(im, soft=True)[0]
        cache[key] = out
        return out
    x, y0 = e['pos']
    full = K.shadow(strip, soft=True)[0]
    self.safe_box(e.get('id', 'receipt'), *self.opaque_box(full, x, y0), t_in, t_out)
    K.moving(self, e.get('id', 'receipt'), picture, x, y0, t_in, t_out + 0.6, enter='none', exit='up', order=60, check=False,
             drift=e.get('drift', True))
    if e.get('sound') == 'print':
        self.sound('m03_print', t_in)
        for _, _, at, seed in marks:
            self.sound(f'm03_felt{1 + seed % 3}', at)
        self.sound('m03_page', t_out)  # the strip rolls back up: one paper sound as loud as the print
    else:
        for k in range(int(dur) + 1):
            self.sound('rustle', t_in + k)
        self.sound('rustle', t_out)
