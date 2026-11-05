"""haul-lineup: the real foods he names land one by one beside him, each on its own word, as a grid like a grocery haul laid out on
a counter (product lineup / beat-synchronised arrivals, awesome-ai-motion #15: the landing, not the start, sits on the word).
Each food is a cut-out of his own photo (or a CC0 one) with a paper tag that does the math for the viewer: the protein in the
serving he means, with the arithmetic and its source on a second line. A food he takes back flicks off; the rest leave together
by the nearer side edge when he moves on.

Each piece is drawn every frame (smooth, motion blurred while it moves: ch4lib.blur_moves) and drops in from above with a small
settle (a 240 px drop, fading in over its first 30%); its land sound plays on the landing frame.

Spec: {type: haul, id, at, out, items: [{image, box: [w, h], centre: [x, y], rot, at (landing second),
       tag: [{text}, {text}] (optional: line 1 big, line 2 small), remove (second, optional)}
       | {note: {text}, centre, rot, at} (a paper strip of words, e.g. the source of every tag)], tag_px: [40, 23]}"""
from PIL import Image, ImageDraw
from overlay import kit
from overlay import look, stage
from overlay.helpers import marker_and_slide as L

DROP_S = 0.42  # the fall: ease-out with a small overshoot that settles back
FALL_PX = 240  # a short drop onto the counter (round 2: a drop from above the frame moved 275-418 px a frame and film-qa lost it)
FADE = 0.3
FLICK_S = 0.42


def fall(x):
    x = min(max(x, 0.0), 1.0)
    return 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2  # easeOutBack, overshoot 1.70158


def ev_haul(self, e):
    t_out = self.T(e['out'])
    big_px, small_px = e.get('tag_px', [40, 23])
    f_big, f_small = kit.sf('display_semibold', big_px), L.face('CourierPrime-Bold.ttf', small_px)
    ink = L.col('ink') + (255,)
    side = e.get('slide', 'right')
    for i, it in enumerate(e['items']):
        if it.get('note'):  # a paper strip of words only (the source line of the whole lineup)
            f_note = L.face('CourierPrime-Bold.ttf', small_px)
            self.seed += 1
            piece = L.paper(int(f_note.getlength(it['note']['text']) + 30), small_px + 24, 'index', self.seed, edge_amp=1, step=10)
            ImageDraw.Draw(piece).text((piece.width / 2, piece.height / 2), it['note']['text'], font=f_note, fill=(92, 88, 80, 255),
                                       anchor='mm')
            piece = piece.rotate(-it.get('rot', 0), expand=True, resample=Image.BICUBIC)
        else:
            bw, bh = it['box']
            im = Image.open(it['image']).convert('RGBA')
            s = min(bw / im.width, bh / im.height)
            im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
            piece = im.rotate(-it.get('rot', 0), expand=True, resample=Image.BICUBIC)
        if it.get('tag'):
            l1, l2 = it['tag'][0]['text'], it['tag'][1]['text']
            tw = int(max(f_big.getlength(l1), f_small.getlength(l2)) + 30)
            th = big_px + small_px + 30
            self.seed += 1
            tag = L.paper(tw, th, 'index', self.seed, edge_amp=1, step=10)
            d = ImageDraw.Draw(tag)
            d.text((tw / 2, 12 + big_px * 0.5), l1, font=f_big, fill=ink, anchor='mm')
            d.text((tw / 2, th - 12 - small_px * 0.5), l2, font=f_small, fill=(92, 88, 80, 255), anchor='mm')
            tag = tag.rotate(it.get('tag_rot', 2.0 if i % 2 else -2.0), expand=True, resample=Image.BICUBIC)
            W = max(piece.width, tag.width)
            H = piece.height + tag.height - 22  # the tag tucks under the food's lower edge
            comb = Image.new('RGBA', (W, H), (0, 0, 0, 0))
            comb.alpha_composite(tag, ((W - tag.width) // 2, H - tag.height))
            comb.alpha_composite(piece, ((W - piece.width) // 2, 0))
            piece = comb
        full, pad = L.shadow(piece, look.R['card']['shadow'])
        cx, cy = it['centre']
        x_end, y_end = round(cx - full.width / 2), round(cy - full.height / 2)
        t_land = self.T(it['at'])
        t_in = t_land - DROP_S
        t_gone = self.T(it['remove']) if it.get('remove') is not None else None
        end = t_gone if t_gone is not None else t_out
        self.safe_box(f"{e.get('id', 'haul')}-{i}", *self.opaque_box(full, x_end, y_end), t_land, end)
        rot_cache = {}

        def dyn(tt, full=full, x_end=x_end, y_end=y_end, t_land=t_land, t_gone=t_gone):
            if tt < t_land - DROP_S:
                return None, 0, 0
            u = (tt - (t_land - DROP_S)) / DROP_S
            y = y_end - (1 - fall(u)) * FALL_PX
            x = x_end
            img = full
            if u < FADE:  # it fades in over the first part of its short fall, so nothing pops in from nowhere at speed
                a = round(max(0.0, u) / FADE, 1)
                if ('a', a) not in rot_cache:
                    f = full.copy()
                    f.putalpha(f.getchannel('A').point(lambda v, a=a: int(v * a)))
                    rot_cache[('a', a)] = f
                img = rot_cache[('a', a)]
            if t_gone is not None and tt >= t_gone:  # flicked off: up and out to the right, turning
                u = (tt - t_gone) / FLICK_S
                if u >= 1:
                    return None, 0, 0
                v = L.ease_in(u)
                ang = round(-28 * v)
                if ang not in rot_cache:
                    rot_cache[ang] = full.rotate(-ang, expand=True, resample=Image.BICUBIC)
                img = rot_cache[ang]
                x = x_end + v * (stage.W - x_end + 80) - (img.width - full.width) / 2
                y = y_end - v * 260 - (img.height - full.height) / 2
            elif tt >= t_out:
                xs = L.slide_x(tt, t_out - 1, t_out, x_end, full.width, side, enter=False)
                if xs is None:
                    return None, 0, 0
                x = xs
            return img, x, y
        sp = kit.SmoothSprite(self, f"{e.get('id', 'haul')}-{i}", None, 0, 0, t_in, 'none', 0, order=e.get('order', 55) + i,
                               jitter=False)
        sp.dynamic = L.blur_moves(dyn)
        self.add(sp)
        self.sound('land', t_land)
        if t_gone is not None:
            self.sound('swish', t_gone)
    self.sound('card_out', t_out)
