"""stapled-note: a ruled index card stapled up with a real stapler sound, a heading in pencil, then one bullet written in pencil
for each thing he names (a to-do he has not done yet: nothing is ticked). Slides out by its nearer side edge when he moves on.

Spec: {type: note, id, pos: [x, y], size: [w, h], rot, at, out, head: {text, at}, items: [{text, at}], font, text_px,
       real_staples (round 2: drawn steel staples, the person: "the staples look weird, just two grey rectangles"), source: {text}, write_s (round 2: lines written on, not popped in)}"""
from PIL import Image, ImageDraw, ImageFilter
from overlay import look, stage
from overlay.helpers import marker_and_slide as L


def staple(card, cx, cy, length, deg):
    """A real staple seen from the front, drawn at 4x and reduced: a round steel wire (crown) with a highlight along its top,
    shade along its bottom and darker rounded ends where the legs bend into the card, a soft contact shadow under it and
    the two small dents the legs punch round the holes."""
    S = 4
    W, H = int(length + 24) * S, 26 * S
    lay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sh = Image.new('L', (W, H), 0)
    x0, x1, yc, r = 12 * S, W - 12 * S, H // 2, int(2.6 * S)
    ImageDraw.Draw(sh).rounded_rectangle([x0 - S, yc - r + 2 * S, x1 + S, yc + r + 3 * S], radius=r, fill=120)
    sh = sh.filter(ImageFilter.GaussianBlur(2.2 * S))
    lay = Image.composite(Image.new('RGBA', (W, H), (60, 52, 40, 255)), Image.new('RGBA', (W, H), (0, 0, 0, 0)), sh)
    d = ImageDraw.Draw(lay)
    for i in range(-r, r + 1):  # the wire's round section: light on top, dark under
        v = i / r
        tone = int(205 - 95 * v - 40 * max(0, v) ** 2) if v > -0.55 else int(150 + 140 * (v + 1))
        d.line([(x0, yc + i), (x1, yc + i)], fill=(tone, tone + 2, tone + 6, 255))
    for ex in (x0, x1):  # the bend into the card
        d.ellipse([ex - r - S, yc - r, ex + r + S, yc + r], fill=(96, 98, 104, 255))
        d.ellipse([ex - r // 2, yc - r // 2, ex + r // 2, yc + r // 2], fill=(70, 70, 74, 255))
    d.line([(x0 + 2 * S, yc - r // 2), (x1 - 2 * S, yc - r // 2)], fill=(244, 246, 250, 255), width=S)
    lay = lay.resize((W // S, H // S), Image.LANCZOS).rotate(deg, expand=True, resample=Image.BICUBIC)
    out = card.copy()
    out.alpha_composite(lay, (int(cx - lay.width / 2), int(cy - lay.height / 2)))
    a = card.getchannel('A')
    out.putalpha(a)
    return out


def ev_stapled_note(self, e):
    w, h = e['size']
    px = e.get('text_px', 34)
    fnt = L.face(e.get('font', 'Kalam-Bold.ttf'), px)
    self.seed += 1
    base = L.paper(w, h, 'index', self.seed, edge_amp=1, step=12)
    d = ImageDraw.Draw(base)
    lh = int(px * 1.45)
    top = int(px * 2.0)
    d.line([(0, top - 10), (w, top - 10)], fill=(214, 120, 120, 255), width=2)  # the index card's red top rule
    for y in range(top - 10 + lh, h - 10, lh):
        d.line([(0, y), (w, y)], fill=(170, 190, 214, 255), width=1)
    if e.get('real_staples'):
        for k, sx in enumerate((w * 0.24, w * 0.76)):  # two staples across the top, each a little off level like a real one
            base = staple(base, sx, 17, 50, (-3.0, 2.2)[k])
    else:
        for k, sx in enumerate((w * 0.28, w * 0.72)):  # two staples across the top
            d.rectangle([sx - 26, 14, sx + 26, 20], fill=(150, 152, 156, 255))
            d.line([(sx - 26, 14), (sx + 26, 14)], fill=(220, 222, 226, 255), width=1)
    d = ImageDraw.Draw(base)
    if e.get('source'):  # where the examples come from, small at the foot of the card
        d.text((int(px * 0.7), h - 16), e['source']['text'], font=L.face('CourierPrime-Bold.ttf', 19), fill=(120, 116, 108, 255), anchor='ls')
    pencil = (58, 58, 62, 255)
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    head_t = self.T(e['head']['at'])
    item_t = [self.T(it['at']) for it in e['items']]
    cache = {}

    write_s = e.get('write_s', 0)  # round 2: each line is written on left to right in write_s, in 6 steps (on twos)

    def done(t0, tt):
        if tt < t0:
            return 0.0
        return 1.0 if not write_s else min(1.0, round((tt - t0) / write_s * 6) / 6)

    def card(tt):
        key = (done(head_t, tt),) + tuple(done(t, tt) for t in item_t)
        if key in cache:
            return cache[key]
        im = base.copy()
        lines = [((int(px * 0.7), top - 12), e['head']['text'])] + [
            ((int(px * 0.9), top - 10 + lh * (i + 1) - 6), '– ' + it['text']) for i, it in enumerate(e['items'])]
        for (xy, text), u in zip(lines, key):
            if u <= 0:
                continue
            lay = Image.new('RGBA', im.size, (0, 0, 0, 0))
            ImageDraw.Draw(lay).text(xy, text, font=fnt, fill=pencil, anchor='ls')
            if u < 1:
                lay = lay.crop((0, 0, int(xy[0] + fnt.getlength(text) * u), lay.height))
            im.alpha_composite(lay, (0, 0))
        out = L.shadow(im.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC), look.R['card']['shadow'])
        cache[key] = out
        return out
    full, pad = card(1e9)
    x_end, y_end = e['pos'][0] - pad, e['pos'][1] - pad
    self.safe_box(e.get('id', 'note'), *self.opaque_box(full, x_end, y_end), t_in, t_out)
    side = L.slide_side(e, x_end, full.width)

    def dyn(tt):
        im, _ = card(tt)
        x = L.slide_x(tt, t_in, t_out, x_end, im.width, side, enter=False)
        if x is None:
            return None, 0, 0
        return im, x, y_end
    sp = stage.Sprite(e.get('id', 'note'), None, 0, 0, t_in, 'slam', look.R['card']['slam_s'], order=e.get('order', 55), jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('staple', t_in)
    pk = e.get('pencil_kinds', ['pencil'])  # round 2: a different pencil take per line, so no take repeats as a loop
    for k, t in enumerate([head_t] + item_t):
        self.sound(pk[k % len(pk)], t)
    self.sound('card_out', t_out)
