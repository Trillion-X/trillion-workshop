"""sum_board (lane ch5): a sum done over the footage, piece by piece as he says it, with real cut-out pictures of what is being
counted (technique: object sticker sum, combining real-object sticker cut-outs (white die-cut border, a pop with a little
overshoot), terms that land on their spoken word, and 3Blue1Brown's role-labelled equation: every term of the result boxed in
its own colour with a plain label of what it is; library/techniques/object-sticker-sum.md).

    {"type": "sum_board", "id": "sum", "pos": [x, y], "size": [w, h], "at": s, "out": s, "exit": "left",
     "items": [
       {"image": "<picture file>", "xy": [x, y], "w": 230, "at": s, "rot": -4},
       {"text": "= 976 calories", "xy": [x, y], "px": 56, "at": s, "colour": [r, g, b]},
       {"text": "1,500", "xy": [x, y], "px": 72, "at": s, "role": {"text": "base rate", "colour": [r, g, b], "at": s}},
       {"style": "minus", "xy": [x, y], "px": 72, "at": s}]}

xy is the item's top-left inside the board. An operator is named by "style" (plus, minus, equals, never a string: every string on
an event is read as on-screen words) and drawn as its sign. A sticker pops in (scale 0.8 to 1.06 to 1 over 0.24 s, ease out back) with a
sticker sound; a text term rises 14 px into place and fades in over 0.18 s with a soft tap. A role box is drawn round its term
(rounded, 4 px, in the role colour) and the role label is written under it in that colour; a role with "fill": true is the
answer: its box fills with the role colour and the term turns to ink inside it. White SF Pro with the soft wide
shadow over footage (text-colour-contrast); "backing": true puts a dark rounded panel (70% opaque) behind the type where the
footage is too bright for white. The board leaves as one piece: an eased slide off the named edge with motion
blur (_ch5_kit.slide) and the swish; it never moves while it is up."""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter
from overlay import kit, look
from overlay import stage
from overlay.kit import ease_out

from overlay.helpers import paper_pieces as K
from overlay.helpers import slide_pieces as C

WHITE = (255, 255, 255)
INK = (27, 26, 23)
SIGNS = {'plus': '+', 'minus': '\u2212', 'equals': '='}


def die_cut(img, w, border=10):
    """The picture scaled to width w with a white die-cut border following its outline."""
    h = int(img.height * w / img.width)
    pic = img.convert('RGBA').resize((w, h), Image.LANCZOS)
    pad = border + 2
    out = Image.new('RGBA', (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    a = Image.new('L', out.size, 0)
    a.paste(pic.getchannel('A'), (pad, pad))
    grown = a.filter(ImageFilter.MaxFilter(2 * border + 1)).filter(ImageFilter.GaussianBlur(1.2))
    white = Image.new('RGBA', out.size, WHITE + (255,))
    white.putalpha(grown.point(lambda v: 255 if v > 90 else int(v * 255 / 90)))
    out.alpha_composite(white)
    out.alpha_composite(pic, (pad, pad))
    return out


def ev_sum_board(self, e):
    sid = e.get('id', 'sum')
    T = self.T
    W, H = e['size']
    items = []
    for it in e['items']:
        d = dict(it, t=T(it['at']))
        if 'image' in it:
            st = die_cut(Image.open(it['image']), it.get('w', 230))
            d['img'] = st.rotate(it.get('rot', 0), expand=True, resample=Image.BICUBIC)
        else:
            f = kit.sf('display_bold', it.get('px', 56))
            text = SIGNS[it['style']] if 'style' in it else it['text']
            b = f.getbbox(text)
            im = Image.new('RGBA', (b[2] - b[0] + 8, b[3] - b[1] + 8), (0, 0, 0, 0))
            ImageDraw.Draw(im).text((4 - b[0], 4 - b[1]), text, font=f, fill=tuple(it.get('colour', WHITE)) + (255,))
            d['img'] = im
            if it.get('role', {}).get('fill'):
                inv = Image.new('RGBA', im.size, INK + (255,))
                inv.putalpha(im.getchannel('A'))
                d['ink_img'] = inv
            if it.get('role'):
                r = it['role']
                fr = kit.sf('text_semibold', r.get('px', 30))
                rb = fr.getbbox(r['text'])
                lab = Image.new('RGBA', (rb[2] - rb[0] + 8, rb[3] - rb[1] + 8), (0, 0, 0, 0))
                ImageDraw.Draw(lab).text((4 - rb[0], 4 - rb[1]), r['text'], font=fr, fill=tuple(r['colour']) + (255,))
                d['role_img'], d['role_t'] = lab, T(r['at'])
        items.append(d)
    # the role boxes of one board share one top and bottom, and their labels one line under them (a comma or a descender
    # makes some terms deeper than others)
    roles = [d for d in items if 'role_img' in d]
    box_top = min((d['xy'][1] - 12 for d in roles), default=0)
    box_bottom = max((d['xy'][1] + d['img'].height + 12 for d in roles), default=0)
    texts = [d for d in items if 'image' not in d]
    panel = None
    if e.get('backing') and texts:  # a dark rounded panel behind the type, for a side of the frame that is too bright for white
        x0 = min(d['xy'][0] for d in texts) - 28
        y0 = min(d['xy'][1] for d in texts) - 24
        x1 = max(d['xy'][0] + d['img'].width for d in texts) + 28
        y1 = max([d['xy'][1] + d['img'].height for d in texts] + [box_bottom + 12 + d['role_img'].height for d in roles]) + 24
        panel = ([x0, y0, x1, y1], min(d['t'] for d in texts))
    t_in = min(d['t'] for d in items)
    t_out = T(e['out'])
    cache = {}

    def picture(tt):
        state = []
        for d in items:
            u = min(1.0, max(0.0, (tt - d['t']) / (0.24 if 'image' in d else 0.18)))
            ru = min(1.0, max(0.0, (tt - d['role_t']) / 0.3)) if 'role_t' in d else 0.0
            state.append((round(u, 2), round(ru, 2)))
        key = tuple(state) + (round(min(1.0, max(0.0, (tt - panel[1]) / 0.18)), 2) if panel else 0,)
        if key in cache:
            return cache[key]
        im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        dd = ImageDraw.Draw(im)
        if panel and tt >= panel[1]:
            pu = min(1.0, (tt - panel[1]) / 0.18)
            dd.rounded_rectangle(panel[0], radius=22, fill=(18, 18, 20, int(178 * pu)))
        for d, (u, ru) in zip(items, state):
            if u <= 0:
                continue
            x, y = d['xy']
            img = d['img']
            if 'image' in d:
                s = 0.8 + 0.2 * C.ease_out_back(u, 2.2)
                sw, sh = max(1, int(img.width * s)), max(1, int(img.height * s))
                im.alpha_composite(img.resize((sw, sh), Image.LANCZOS), (int(x + (img.width - sw) / 2), int(y + (img.height - sh) / 2)))
                continue
            lay = img.copy()
            lay.putalpha(lay.getchannel('A').point(lambda v: int(v * u)))
            im.alpha_composite(lay, (int(x), int(y + 14 * (1 - ease_out(u)))))
            if ru > 0:
                colour = tuple(d['role']['colour'])
                box = [x - 14, box_top, x + img.width + 14, box_bottom]
                if 'ink_img' in d:
                    dd.rounded_rectangle(box, radius=10, fill=colour + (int(255 * ru),))
                    ink = d['ink_img'].copy()
                    ink.putalpha(ink.getchannel('A').point(lambda v: int(v * ru)))
                    im.alpha_composite(ink, (int(x), int(y)))
                else:
                    dd.rounded_rectangle(box, radius=10, outline=colour + (int(255 * ru),), width=4)
                lab = d['role_img'].copy()
                lab.putalpha(lab.getchannel('A').point(lambda v: int(v * ru)))
                im.alpha_composite(lab, (int(x + (img.width - lab.width) / 2), int(box_bottom + 12)))
        out = stage.shadowed(im, look.LOOK['text_shadow'])[0]
        if len(cache) > 16:
            cache.pop(next(iter(cache)))
        cache[key] = out
        return out

    x, y = e['pos']
    C.slide(self, sid, picture, x, y, t_in, t_out, enter='none', exit=e.get('exit', 'left'), order=60)
    for k, d in enumerate(items):
        self.sound('sticker_place' if 'image' in d else 'tap', d['t'])
        if d['t'] > t_in:  # every piece is its own landing in the timeline (film-qa settle judges the board from each one to the next)
            self.log.append({'id': f'{sid}-{k}', 'at': round(d['t'], 3)})
    self.sound('card_out', t_out)
