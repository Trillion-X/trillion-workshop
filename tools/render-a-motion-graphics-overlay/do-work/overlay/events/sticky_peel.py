"""sticky_peel (lane ch3): an assumption written in quotes on a sticky note; a red question mark is drawn on it when he
questions it, and when he removes it the note is peeled up off its corner and flicked away out of frame (technique:
sticky-note peel; filmcraft/options-ch3/TECHNIQUES.md#sticky-note-peel).

    {"type": "sticky_peel", "id": "assume", "pos": [x, y], "size": 460, "height": 360, "rot": -4,
     "text": "“we need all these chemicals”", "at": s, "qmark_at": s, "peel_at": s}

The note is cream paper with a darker glue band (one-palette: no yellow); ink marker words; the question mark is the
film's accent red. Sounds: the note pressed on, the marker, the peel, the flick (sound-per-element, exits differ).

Round-2 keys (name-the-idea-on-screen, split-long-stretches, documents-settle-still):
    "heading": "QUESTION\nTHE ASSUMPTION", "heading_px": 40, "heading_at": s   the idea's own name written above the quote,
                                                                              underlined, on its cue
    "text_at": s, "write_s": 1.0     the quote is written on line by line on its cue (default: on the note from the start)
    "away": [s, s]                   the note leaves while he talks around it and comes back before it is questioned
    "drift": false                   the note sits still once it has landed
    "sounds": {"press", "write", "qmark", "peel", "flick"}   sound kind per action (defaults: thump, marker, marker, peel,
                                                             slide_out)"""
import os
import sys
from PIL import Image, ImageDraw
from overlay import stage
from overlay.helpers import paper_pieces as K


def _write_on(lines, frac):
    """Handwritten lines revealed one after another, left to right, as a hand writes them (frac 0..1 of all the ink)."""
    total = sum(l.width for l in lines)
    left = total * frac
    out = []
    for l in lines:
        out.append(K.reveal(l, left / l.width) if left < l.width else l)
        left = max(0.0, left - l.width)
    return out


def ev_sticky_peel(self, e):
    s, nh = e.get('size', 360), e.get('height', e.get('size', 360))  # width, height
    self.seed += 1
    note = K.paper(s, nh, 'cream', self.seed, edge='straight')
    d = ImageDraw.Draw(note)
    d.rectangle([0, 0, s, int(nh * 0.14)], fill=(226, 214, 186, 255))  # the glue band, a shade darker
    face_name = e.get('face', 'PermanentMarker-Regular.ttf')
    qh = int(nh * 0.62) if e.get('heading') else nh  # with a heading the question mark is sized to the quote below it
    qfont = K.face('PermanentMarker-Regular.ttf', int(qh * 0.5))
    qm = Image.new('RGBA', (int(qh * 0.34), int(qh * 0.56)), (0, 0, 0, 0))
    snd = dict({'press': 'thump', 'write': 'marker', 'qmark': 'marker', 'peel': 'peel', 'flick': 'slide_out'}, **e.get('sounds', {}))
    t_in, t_q, t_p = self.T(e['at']), self.T(e['qmark_at']), self.T(e['peel_at'])
    heads, ty = [], int(nh * 0.19)
    if e.get('heading'):  # the idea's name, written above the quote and underlined
        heads = [K.hand(l, face_name, e.get('heading_px', 40), spacing=0.86) for l in e['heading'].split('\n')]
        ty = int(nh * 0.17) + sum(h.height for h in heads) + 26
    words = [K.hand(l, face_name, e.get('text_px', 46), spacing=1.05) for l in e['text'].split('\n')]
    if max(w.width for w in words) > s - qm.width - 40:  # the question mark gets its own column on the right
        raise SystemExit(f'{self.id}: the note text is {max(w.width for w in words)}px wide; break it with \\n to fit {s - qm.width - 40}px')
    if heads and ty + sum(wd.height for wd in words) + 16 > nh:
        raise SystemExit(f'{self.id}: heading and quote need {ty + sum(wd.height for wd in words) + 16}px; the note is {nh}px high')
    if heads and max(h.width for h in heads) > s - 40:
        raise SystemExit(f'{self.id}: the heading is {max(h.width for h in heads)}px wide; break it with \\n to fit {s - 40}px')
    if not e.get('text_at') and not heads:  # round 1: the quote is on the note from the start, as one block
        block = K.hand(e['text'], face_name, e.get('text_px', 46), spacing=1.05)
        note.alpha_composite(block, (26, ty))
        words = []
    ImageDraw.Draw(qm).text((qm.width / 2, qm.height / 2), '?', font=qfont, fill=K.RED + (255,), anchor='mm')
    t_head = self.T(e.get('heading_at', e['at'])) if heads else None
    t_text = self.T(e['text_at']) if e.get('text_at') else t_in
    write_s = e.get('write_s', 0.9)
    lift = 0.22
    cache = {}

    def picture(tt):
        fh = 0.0 if t_head is None or tt < t_head else min(1.0, (tt - t_head) / write_s)
        ft = 0.0 if tt < t_text else min(1.0, (tt - t_text) / write_s) if e.get('text_at') else 1.0
        fq = 0.0 if tt < t_q else min(1.0, (tt - t_q) / 0.4)
        fl = 0.0 if tt < t_p else min(1.0, (tt - t_p) / lift)
        key = (round(fh, 2), round(ft, 2), round(fq, 2), round(fl, 2))
        if key in cache:
            return cache[key]
        im = note.copy()
        y = int(nh * 0.17)
        if heads and fh > 0:
            dr = ImageDraw.Draw(im)
            for h in _write_on(heads, fh):
                im.alpha_composite(h, (22, y))
                y += h.height
            if fh >= 1:  # the underline, drawn as the last stroke of the heading
                dr.line([(26, y + 8), (26 + max(h.width for h in heads) - 10, y + 4)], fill=K.INK + (255,), width=5)
        y = ty
        for l in _write_on(words, ft) if words else []:
            im.alpha_composite(l, (26, y))
            y += l.height
        if fq > 0:  # drawn from the top down
            part = qm.copy()
            a = part.getchannel('A')
            cut = int(qm.height * fq)
            ImageDraw.Draw(a).rectangle([0, cut, qm.width, qm.height], fill=0)
            part.putalpha(a)
            im.alpha_composite(part, (s - qm.width - 10, ty - int(nh * 0.02) if heads else int(nh * 0.3)))
        rot = e.get('rot', 0) + 9 * fl
        if fl > 0:  # peeling: the free corner lifts, so the note foreshortens and its shadow grows
            im = im.resize((s, int(nh * (1 - 0.12 * fl))), Image.BICUBIC)
        im = im.rotate(-rot, expand=True, resample=Image.BICUBIC)
        out = stage.shadowed(im, {'dx': 4 + 8 * fl, 'dy': 8 + 14 * fl, 'blur': 14 + 10 * fl, 'opacity': 0.38})[0]
        cache[key] = out
        return out
    x, y = e['pos']
    sid, drift, enter = e.get('id', 'note'), e.get('drift', True), e.get('enter', 'top')
    if e.get('away'):  # leaves while he talks around it, comes back before it is questioned
        t_leave, t_back = self.T(e['away'][0]), self.T(e['away'][1])
        K.moving(self, sid, picture, x, y, t_in, t_leave, enter=enter, exit=e.get('away_exit', 'left'), order=62, drift=drift)
        K.moving(self, sid + '-back', picture, x, y, t_back, t_p + lift, enter=e.get('away_exit', 'left'), exit='flick', order=62,
                 drift=drift)
        self.sound('slide_out', t_leave)
        self.sound('slide_in', t_back)
    else:
        K.moving(self, sid, picture, x, y, t_in, t_p + lift, enter=enter, exit='flick', order=62, drift=drift)
    self.sound(snd['press'], t_in + 0.3)
    if heads:
        self.sound(snd['write'], t_head)
    if e.get('text_at'):
        self.sound(snd['write'], t_text)
    self.sound(snd['qmark'], t_q)
    self.sound(snd['peel'], t_p)
    self.sound(snd['flick'], t_p + lift)
