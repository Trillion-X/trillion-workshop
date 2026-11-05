"""label_highlight (lane ch3): a real label as the receipt for a claim, set in a window beside him with its source line
under it; on his words a marker band sweeps behind each named phrase, left to right, one after another (highlighter
sweep, #089, awesome-ai-motion). The view can also push in to one part (zoom: 1.0 keeps the whole label; a push crops the
line ends, so chapter 3 does not use it).

    {"type": "label_highlight", "id": "label", "pos": [x, y], "w": 520, "h": null (fits the label), "title": "Impossible Burger",
     "heading": "INGREDIENTS:", "text": "...", "source": "label text on amazon.com, read 21 Oct 2026",
     "at": s, "out": s, "zoom_at": s, "zoom": 1.9, "focus": "2%",       the view centres on the line holding this phrase
     "marks": [{"phrase": "Methylcellulose,", "at": s}, ...]}            each band takes 0.35 s

Ink on white label stock; bands in the film's one accent red at low strength (one-palette, no yellow).

Round-2 keys (absent: round 1 as it was):
    "look": "highlighter"     each mark is a real highlighter stroke (kit highlight_onto) multiplied into the label, one
                              stroke per line the phrase runs across, written on left to right (real-highlighter-look)
    "sound": "felt"           a soft felt-tip stroke per mark (m03_felt1-3) instead of the whiteboard marker
    "label": "...", "label_at": s
                              a short note in red pen (a newline between lines) written on under the label from label_at, line after line
                              (about 0.035 s a letter)
    "source" may be left out: no line under the label"""
import math
import os
import sys
from PIL import Image, ImageDraw
from overlay import stage
from overlay.helpers import paper_pieces as K


def ev_label_highlight(self, e):
    W = e['w']
    S = 2  # the label is drawn at 2x so the push-in stays sharp
    pad = 30 * S
    fnt = K.face(e.get('face', '/Library/Fonts/SF-Pro-Text-Semibold.otf'), e.get('size', 25) * S)
    ftitle = K.face(e.get('title_face', '/Library/Fonts/SF-Pro-Display-Heavy.otf'), e.get('title_px', 40) * S)
    asc, desc = fnt.getmetrics()
    lh = int((asc + desc) * 1.18)
    lines, boxes = K.text_layout(e['heading'] + ' ' + e['text'], fnt, W * S - 2 * pad)
    th = ftitle.getbbox(e['title'])[3] + 18 * S
    doc_h = pad + th + lh * len(lines) + pad
    H = e.get('h') or math.ceil(doc_h / S)  # default: the window shows the whole label before the push
    doc = Image.new('RGBA', (W * S, max(doc_h, H * S)), (250, 249, 244, 255))
    doc = stage.apply_texture(doc, 'sheet', 3, 0.15)
    d = ImageDraw.Draw(doc)
    d.text((pad, pad), e['title'], font=ftitle, fill=K.INK + (255,))
    d.line([(pad, pad + th - 10 * S), (W * S - pad, pad + th - 10 * S)], fill=K.INK + (255,), width=3 * S)
    y0 = pad + th
    words = (e['heading'] + ' ' + e['text']).split(' ')

    def word_box(i):
        ln, x0, x1 = boxes[i]
        return pad + x0, y0 + ln * lh, pad + x1, y0 + ln * lh + asc + desc
    for i, ln in enumerate(lines):
        d.text((pad, y0 + i * lh), ln, font=fnt, fill=K.INK + (255,))
    # bold heading: draw it again offset by a pixel
    d.text((pad + 1, y0), e['heading'], font=fnt, fill=K.INK + (255,))

    def phrase_box(ph):
        toks = ph.split(' ')
        for i in range(len(words) - len(toks) + 1):
            if words[i:i + len(toks)] == toks:
                bs = [word_box(j) for j in range(i, i + len(toks))]
                return [b for b in bs]
        raise SystemExit(f'{self.id}: phrase "{ph}" is not on the label')
    marks = [(phrase_box(m['phrase']), self.T(m['at'])) for m in e.get('marks', [])]
    fb = phrase_box(e['focus'])[0]
    fy = (fb[1] + fb[3]) / 2
    t_in, t_out, t_z = self.T(e['at']), self.T(e['out']), self.T(e['zoom_at'])
    z1 = e.get('zoom', 1.9)
    src = K.hand(e['source'], 'SpecialElite-Regular.ttf', e.get('source_px', 19)) if e.get('source') else None
    note = [K.hand(ln, 'Kalam-Bold.ttf', e.get('label_px', 28), colour=K.RED) for ln in e['label'].split('\n')] if e.get('label') else None
    t_note = self.T(e['label_at']) if note else None
    frame_pad = 14
    cap_h = (src.height + 14 if src else 0) + (sum(n.height for n in note) + 8 if note else 0)
    highlighter = e.get('look') == 'highlighter'
    strokes = []  # highlighter: one stroke per line a phrase runs across
    for bs, _ in marks:
        lines_of = {}
        for b in bs:
            k = (b[1], b[3])
            lines_of[k] = (min(lines_of.get(k, b)[0], b[0]), b[1], max(lines_of.get(k, b)[2], b[2]), b[3])
        strokes.append([(b[0] - 5 * S, b[1] + 1 * S, b[2] + 5 * S, b[3] + 1 * S) for b in lines_of.values()])
    cache = {}

    def picture(tt):
        u = 0.0 if tt < t_z else min(1.0, (tt - t_z) / 1.4)
        u = 0.5 - 0.5 * math.cos(math.pi * u)  # in and out of the push smoothly
        fr = [0.0 if tt < at else min(1.0, (tt - at) / 0.35) for _, at in marks]
        fn = 0.0 if note is None or tt < t_note else min(1.0, (tt - t_note) / (0.035 * len(e['label'])))
        key = (round(u * 48), tuple(round(f, 2) for f in fr), round(fn, 2))
        if key in cache:
            return cache[key]
        im = doc.copy()
        if highlighter:
            for k, (sk, f) in enumerate(zip(strokes, fr)):
                left = f * len(sk)
                for b in sk:
                    if left <= 0:
                        break
                    K.highlight_onto(im, b, 'red', min(1.0, left), k + 2)
                    left -= 1
        band = Image.new('RGBA', im.size, (0, 0, 0, 0))
        bd = ImageDraw.Draw(band)
        for (bs, _), f in zip(marks, fr):
            if f <= 0 or highlighter:
                continue
            total = sum(b[2] - b[0] + 8 * S for b in bs)
            left = total * f
            for b in bs:  # a phrase can break across lines: the band follows it word by word
                seg = min(b[2] - b[0] + 8 * S, left)
                if seg <= 0:
                    break
                bd.rectangle([b[0] - 4 * S, b[1] + 4 * S, b[0] - 4 * S + seg, b[3] - 2 * S], fill=K.RED + (82,))
                left -= b[2] - b[0] + 8 * S
        im = Image.alpha_composite(im, band) if any(f > 0 for f in fr) and not highlighter else im
        z = 1 + (z1 - 1) * u
        vw, vh = W * S / z, H * S / z
        cy = H * S / 2 + (fy - H * S / 2) * u
        top = min(max(cy - vh / 2, 0), im.height - vh)
        left = (W * S - vw) * e.get('focus_x', 0.0)
        view = im.crop((int(left), int(top), int(left + vw), int(top + vh))).resize((W, H), Image.LANCZOS)
        card = Image.new('RGBA', (W + 2 * frame_pad, H + 2 * frame_pad + cap_h), (250, 249, 244, 255))
        card.paste(view, (frame_pad, frame_pad))
        ImageDraw.Draw(card).rectangle([frame_pad - 1, frame_pad - 1, frame_pad + W, frame_pad + H], outline=(200, 196, 186, 255), width=1)
        if src:
            card.alpha_composite(src, (frame_pad, H + 2 * frame_pad + 2))
        if note and fn > 0:  # written line after line, as a hand writes
            ny, left = H + 2 * frame_pad + (src.height + 14 if src else 4), fn * sum(n.width for n in note)
            for n in note:
                if left > 0:
                    card.alpha_composite(K.reveal(n, left / n.width), (frame_pad, ny))
                left -= n.width
                ny += n.height
        out = K.shadow(card.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC))[0]
        cache[key] = out
        return out
    x, y = e['pos']
    K.moving(self, e.get('id', 'doc'), picture, x, y, t_in, t_out, enter=e.get('enter', 'left'), exit=e.get('exit', 'left'), order=60,
             drift=e.get('drift', True))
    self.sound('slide_in', t_in)
    for k, (_, at) in enumerate(marks):
        self.sound(f'm03_felt{1 + k % 3}' if e.get('sound') == 'felt' else 'marker', at)
    if note:
        self.sound('m03_felt2' if e.get('sound') == 'felt' else 'marker', t_note)
    self.sound('slide_out', t_out)
