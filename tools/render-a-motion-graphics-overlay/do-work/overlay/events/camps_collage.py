"""camps_collage (lane ch2, round 2, 4:47 "animal or vegan" A): the two camps as his own food, cut out of his own photos and
thrown onto one side of the frame (`side`: -1 left, 1 right) as a collage (photo cut-out scrapbook, from his editor list: "photo cutout scrapbook
effect"); each camp gets a masking-tape label written on in marker; the camp he is talking about comes forward and the
other one fades back or leaves; each camp's reason is written on a tape note as he gives it, with a marker underline on
his "not right" (scribble write-on, his list: Justin Odisho / cineguac); each camp leaves once his point about it is made
(the person's rules synthetic-8e516febea45); on "the science behind every food item" two real nutrition labels from his own
groceries land, one per camp, and real
highlighter passes mark what each one has on "what is in them nutrient wise" (Vox-style document highlight).
filmcraft/options-ch2/work-round-2/pick-m07.md has what was studied.

    {"type": "camps_collage", "id": "camps", "side": -1 or 1,
     "camps": [{"center": [x, y], "at": s, "out": s,                     a camp can come back as a new entry
                "photos": [{"image": path, "h": px, "rot": deg, "off": [dx, dy]}, ...],
                "tag": {"text": "animal-based", "at": s, "off": [dx, dy], "rot": deg, "size": 40}}, ...],
     "focus": [{"to": 0 or 1, "at": s}, ...],                          camp index brought forward from that time
     "notes": [{"text": "...", "of": camp index, "at": s, "out": s, "pos": [x, y], "rot": deg, "size": 36,
                "underline": {"at": s}}, ...],                          underline: red marker under the last line
     "rings": [{"of": camp index, "at": s}],                            red marker loop round a camp
     "cards": [{"image": path, "crop": [x0, y0, x1, y1], "w": px, "center": [x, y], "rot": deg, "at": s,
                "tag": {"text": "...", "off": [dx, dy], "rot": deg, "size": 34},
                "marks": [{"box": [x0, y0, x1, y1], "colour": "green", "at": s, "style": "loop" or "highlight"}]}],
                                                                        box in crop px; loop = marker ring (default)
     "out": s}
"""
import math

from PIL import Image
from overlay import kit, look, stage
from overlay.kit import SmoothSprite

from overlay.helpers.table_objects import (contact_shadow, dimmed, ease_io, ease_in, ease_out, fit_h, fit_w, highlighter, load_photo,
                                 marker_path, rounded, scaled, tape_label, with_blur, write_on, FRAME_S)
from overlay.helpers.sound_classes import play

RED = (226, 40, 40)
MARKER = {'red': RED, 'green': (22, 150, 62), 'blue': (30, 90, 220)}
# exit travel: with the cubic ease-in and its motion-blur trail, 2000 px keeps every piece moving until it and its
# blur are past the frame edge (film-qa exits: 1100 px let a card vanish with its blur still on screen)
SWEEP = 2000


def ev_camps_collage(self, e):
    sid = e.get('id', 'camps')
    T = self.T
    side = e.get('side', 1)
    t_out = T(e['out']) if 'out' in e else None
    focus = sorted(((T(f['at']), f['to']) for f in e.get('focus', [])))

    # ---------- camps: one pre-composed collage per camp ----------
    camps = []
    for k, c in enumerate(e.get('camps', [])):
        pieces = []
        for j, p in enumerate(c['photos']):
            im = fit_h(load_photo(p['image']), p['h'])
            im = im.rotate(p.get('rot', 0), expand=True, resample=Image.BICUBIC)
            im, pad = contact_shadow(im)
            pieces.append((im, p.get('off', [0, 0])))
        x0 = min(o[0] - im.width / 2 for im, o in pieces)
        y0 = min(o[1] - im.height / 2 for im, o in pieces)
        x1 = max(o[0] + im.width / 2 for im, o in pieces)
        y1 = max(o[1] + im.height / 2 for im, o in pieces)
        x0, y0, x1, y1 = x0 - 70, y0 - 70, x1 + 70, y1 + 70  # room for its tape label and marker loop
        layer = Image.new('RGBA', (int(x1 - x0), int(y1 - y0)), (0, 0, 0, 0))
        for im, o in pieces:
            layer.alpha_composite(im, (int(o[0] - im.width / 2 - x0), int(o[1] - im.height / 2 - y0)))
        tg = c['tag']
        tape, ink, lines, lh, tpad = tape_label(tg['text'], tg.get('size', 40), seed=11 + k)
        camps.append({'ob': None, 't_out': T(c['out']), 'layer': layer, 'dim': dimmed(layer, 1.0), 'origin': (x0, y0), 'center': c['center'], 't_in': T(c['at']),
                      'tag': (tape, ink, lines, lh, tpad), 't_tag': T(tg['at']), 'tag_off': tg.get('off', [0, 0]),
                      'tag_rot': tg.get('rot', 0), 'k': k, 'n_chars': len(tg['text'])})
        ob = layer.getchannel('A').point(lambda v: 255 if v > 200 else 0).getbbox()
        camps[-1]['ob'] = ob
        bx = c['center'][0] - layer.width / 2, c['center'][1] - layer.height / 2
        self.safe_box(f'{sid}-camp{k}', bx[0] + ob[0], bx[1] + ob[1], bx[0] + ob[2], bx[1] + ob[3], T(c['at']), T(c['out']))
    rings = [(T(r['at']), r['of']) for r in e.get('rings', [])]

    def active_amount(k, tt):
        """0 = forward, 1 = faded back, eased over 0.35 s from the value it had at each focus change."""
        val = 0.0
        for t, to in focus:
            if tt < t:
                break
            val += ((0.0 if to == k else 1.0) - val) * ease_io((tt - t) / 0.35)
        return val

    def camp_pos(c, tt):
        """Anchor (centre) of a camp at tt: thrown in from its side of the frame, then swept back off that side."""
        cx, cy = c['center']
        if tt < c['t_in']:
            return None
        u = ease_out((tt - c['t_in']) / 0.45)
        x = cx + side * (1 - u) * 900
        y = cy - math.sin(u * math.pi) * 18
        ts = c['t_out']
        if tt > ts:
            v = ease_in((tt - ts) / 0.5)
            if v >= 1:
                return None
            x += side * v * SWEEP
            y -= math.sin(v * math.pi / 2) * 70
        return x, y

    def flicked(img, since_out):
        """Exit: the piece is swept off the table by a hand, so it spins away from the hinge as it travels (paper-world
        exit, the person's rules exit-with-character) instead of a flat slide."""
        if since_out <= 0:
            return img
        v = ease_in(since_out / 0.5)
        return img.rotate(-side * 22 * v, expand=True, resample=Image.BICUBIC) if v > 0.01 else img

    def camp_dyn(c):
        def dyn(tt):
            p = camp_pos(c, tt)
            if p is None:
                return None, 0, 0
            amt = active_amount(c['k'], tt)
            img = Image.blend(c['layer'], c['dim'], amt) if amt > 0.01 else c['layer'].copy()
            # its tape label, written on at pen speed
            tape, ink, lines, lh, tpad = c['tag']
            u = (tt - c['t_tag']) / max(0.3, min(0.7, c['n_chars'] * 0.05))
            if u > 0:
                tg = write_on(tape, ink, lines, lh, tpad, u)
                pop = 0.9 + 0.1 * ease_out((tt - c['t_tag'] + 0.08) / 0.15)
                tg = scaled(tg, pop).rotate(c['tag_rot'], expand=True, resample=Image.BICUBIC)
                ox, oy = c['tag_off']
                img.alpha_composite(tg, (int(img.width / 2 + ox - tg.width / 2), int(img.height / 2 + oy - tg.height / 2)))
            # red marker loop round the camp
            for t_r, of in rings:
                fade = 1 - (tt - (c['t_out'] - 0.25)) / 0.2       # the loop lifts off before the camp moves away
                if of == c['k'] and tt >= t_r and fade > 0:
                    x0r, y0r, x1r, y1r = c['ob']
                    mx, my, rx_, ry_ = (x0r + x1r) / 2, (y0r + y1r) / 2, (x1r - x0r) / 2 + 10, (y1r - y0r) / 2 + 14
                    pts = [(mx + rx_ * math.cos(a), my + ry_ * math.sin(a)) for a in [math.radians(200 + 380 * i / 60) for i in range(61)]]
                    ring, rx, ry = marker_path(pts, 7, RED, ease_out((tt - t_r) / 0.55), seed=5)
                    if fade < 1:
                        ring.putalpha(ring.getchannel('A').point(lambda v, f=fade: int(v * f)))
                    img.alpha_composite(ring, (int(rx), int(ry)))
            s = 1.0 - 0.12 * amt
            img = flicked(scaled(img, s), tt - c['t_out'])
            x, y = p[0] - img.width / 2, p[1] - img.height / 2
            return with_blur(img, x, y, p, camp_pos(c, tt - 1.5 * FRAME_S))
        return dyn

    for c in camps:
        sp = SmoothSprite(self, f'{sid}-camp{c["k"]}', None, 0, 0, c['t_in'], 'none', 0, order=40 + c['k'], jitter=False)
        sp.dynamic = camp_dyn(c)
        self.add(sp)
        play(self, 'ch2_card', c['t_in'])
        play(self, 'ch2_line', c['t_tag'], max_s=max(0.3, min(0.7, c['n_chars'] * 0.05)))
        play(self, 'ch2_out', c['t_out'])
    for t, _ in focus[1:]:
        play(self, 'ch2_slide', t)
    for t_r, _ in rings:
        play(self, 'ch2_line', t_r, max_s=0.55)

    # ---------- reason notes ----------
    for n, nt in enumerate(e.get('notes', [])):
        tape, ink, lines, lh, tpad = tape_label(nt['text'], nt.get('size', 36), seed=31 + n)
        t_in, t_n_out = T(nt['at']), T(nt['out'])
        write_s = max(0.4, min(1.1, len(nt['text']) * 0.035))
        cx, cy = nt['pos']
        ul = nt.get('underline')
        t_ul = T(ul['at']) if ul else None
        rot = nt.get('rot', 0)
        self.safe_box(f'{sid}-note{n}', cx - tape.width / 2, cy - tape.height / 2, cx + tape.width / 2, cy + tape.height / 2, t_in, t_n_out)

        def note_pos(tt, cx=cx, cy=cy, t_n_out=t_n_out):
            if tt >= t_n_out:
                v = ease_in((tt - t_n_out) / 0.45)
                return None if v >= 1 else (cx + side * v * SWEEP, cy - math.sin(v * math.pi / 2) * 70)
            return cx, cy

        def note_dyn(tt, tape=tape, ink=ink, lines=lines, lh=lh, tpad=tpad, t_in=t_in, write_s=write_s, t_ul=t_ul, rot=rot,
                     note_pos=note_pos, t_n_out=t_n_out):
            p = note_pos(tt)
            if p is None:
                return None, 0, 0
            img = write_on(tape, ink, lines, lh, tpad, (tt - t_in) / write_s)
            if t_ul is not None and tt >= t_ul:
                y = img.height - tpad[1] + 2
                w = img.width
                line, lx, ly = marker_path([(tpad[0], y), (w * 0.45, y + 3), (w - tpad[0], y - 2)], 6, (226, 40, 40),
                                           ease_out((tt - t_ul) / 0.3), seed=7)
                img.alpha_composite(line, (int(lx), int(ly)))
            img = scaled(img, 0.92 + 0.08 * ease_out((tt - t_in) / 0.15)).rotate(rot, expand=True, resample=Image.BICUBIC)
            img = flicked(img, tt - t_n_out)
            x, y = p[0] - img.width / 2, p[1] - img.height / 2
            return with_blur(img, x, y, p, note_pos(tt - 1.5 * FRAME_S))
        sp = SmoothSprite(self, f'{sid}-note{n}', None, 0, 0, t_in, 'none', 0, order=50 + n, jitter=False)
        sp.dynamic = note_dyn
        self.add(sp)
        play(self, 'ch2_card', t_in - 0.05)
        play(self, 'ch2_line', t_in + 0.05, max_s=min(0.7, write_s))
        if t_ul is not None:
            play(self, 'ch2_line', t_ul, max_s=0.3)
        play(self, 'ch2_out', t_n_out)

    # ---------- the two real labels ----------
    for k, cd in enumerate(e.get('cards', [])):
        src = load_photo(cd['image'], cd.get('crop'))
        card = fit_w(src, cd['w'])
        sc = card.width / src.width
        card = rounded(card, 8)
        mpad = 26  # room round the card for a marker loop on an edge row
        padded = Image.new('RGBA', (card.width + 2 * mpad, card.height + 2 * mpad), (0, 0, 0, 0))
        padded.alpha_composite(card, (mpad, mpad))
        card = padded
        marks = [([b * sc + mpad for b in m['box']], m['colour'], T(m['at']), 40 + k * 7 + i, m.get('style', 'loop'))
                 for i, m in enumerate(cd.get('marks', []))]
        tg = cd.get('tag')
        tag = tape_label(tg['text'], tg.get('size', 34), seed=51 + k) if tg else None
        t_in = T(cd['at'])
        cx, cy = cd['center']
        rot = cd.get('rot', 0)
        iw, ih = card.width - 2 * mpad, card.height - 2 * mpad
        self.safe_box(f'{sid}-card{k}', cx - iw / 2 - 6, cy - ih / 2 - 30, cx + iw / 2 + 6, cy + ih / 2 + 10, t_in, t_out)

        def card_pos(tt, cx=cx, cy=cy, t_in=t_in, k=k):
            if tt < t_in:
                return None
            u = ease_out((tt - t_in) / 0.4)
            x = cx + side * (1 - u) * 1000
            to = t_out + 0.08 * k
            if tt > to:
                v = ease_in((tt - to) / 0.5)
                if v >= 1:
                    return None
                x += side * v * SWEEP
                return x, cy - math.sin(v * math.pi / 2) * 70
            return x, cy

        def card_dyn(tt, card=card, marks=marks, tag=tag, tg=tg, rot=rot, card_pos=card_pos, t_in=t_in):
            p = card_pos(tt)
            if p is None:
                return None, 0, 0
            img = card
            for box, colour, t_m, seed, style in marks:
                if tt < t_m:
                    continue
                if style == 'highlight':
                    img = highlighter(img, box, colour, ease_io((tt - t_m) / 0.32), seed)
                    continue
                # a marker loop round the row, the same hand as the camp ring (one drawn language in this option)
                x0, y0, x1, y1 = box
                cxm, cym, rx, ry = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 + 10, (y1 - y0) / 2 + 6
                pts = [(cxm + rx * math.cos(a), cym + ry * math.sin(a)) for a in [math.radians(190 + 385 * i / 48) for i in range(49)]]
                loop, lx, ly = marker_path(pts, 5, MARKER[colour], ease_out((tt - t_m) / 0.4), seed=seed)
                img = img.copy()
                img.alpha_composite(loop, (int(lx), int(ly)))
            img, pad = contact_shadow(img, dy=12, blur=18, opacity=0.55)
            if tag:
                tape, ink, lines, lh, tpad = tag
                tgi = write_on(tape, ink, lines, lh, tpad, (tt - t_in - 0.25) / 0.45).rotate(tg.get('rot', 0), expand=True,
                                                                                           resample=Image.BICUBIC)
                big = Image.new('RGBA', (img.width, img.height + tgi.height), (0, 0, 0, 0))
                big.alpha_composite(img, (0, tgi.height // 2))
                ox, oy = tg.get('off', [0, 0])
                big.alpha_composite(tgi, (int(pad + ox), int(oy)))
                img = big
            img = flicked(img.rotate(rot, expand=True, resample=Image.BICUBIC), tt - (t_out + 0.08 * k))
            x, y = p[0] - img.width / 2, p[1] - img.height / 2
            return with_blur(img, x, y, p, card_pos(tt - 1.5 * FRAME_S))
        sp = SmoothSprite(self, f'{sid}-card{k}', None, 0, 0, t_in, 'none', 0, order=60 + k, jitter=False)
        sp.dynamic = card_dyn
        self.add(sp)
        play(self, 'ch2_card', t_in)
        for _, _, t_m, _, _ in marks:
            play(self, 'ch2_line', t_m, max_s=0.32)
        play(self, 'ch2_out', t_out + 0.08 * k)
