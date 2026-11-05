"""water-glasses: two glasses on a paper card, each full of its drink; on the word, water rises inside each to its real share
by weight (Vox-style proportion fill: Unit Grid Fill #245 and the glass-fill device, df8e9fc4, with the share as the fill
level instead of named layers). The numbers come from USDA FoodData Central (water g per 100 g); the share label writes in
under its glass as the fill lands, and a source line sits at the foot of the card.

Every frame is drawn (the fill is smooth); the card slides in and out by its nearer side edge like the other cards.

Spec: {type: glasses, id, pos: [x, y], size: [w, h], at, out, text_px,
       glasses: [{text (its name), fill_at, pct (0-100), drink: [r, g, b], label: {text}}], source: {text}}"""
from PIL import Image, ImageDraw
from overlay import kit
from overlay import look
from overlay.helpers import marker_and_slide as L

FILL_S = 0.9
WATER = (92, 160, 222)  # the water, and the share label in a darker blue (colour by meaning: water)


def ev_glasses(self, e):
    W, H = e['size']
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    px = e.get('text_px', 36)
    f_name, f_lab = kit.sf('display_semibold', px), kit.sf('display_semibold', px + 4)
    f_src = L.face('CourierPrime-Bold.ttf', 19)
    ink = L.col('ink') + (255,)
    self.seed += 1
    card = L.paper(W, H, 'index', self.seed, edge_amp=1, step=12)
    n = len(e['glasses'])
    gw, gh = int(W / n * 0.52), int(H * 0.56)
    top = int(px * 2.0)
    lab_y = top + gh + 18
    d = ImageDraw.Draw(card)
    geo = []
    for i, g in enumerate(e['glasses']):
        cx = int(W / n * (i + 0.5))
        x0, x1 = cx - gw // 2, cx + gw // 2
        inset = int(gw * 0.09)
        poly = [(x0, top), (x1, top), (x1 - inset, top + gh), (x0 + inset, top + gh)]
        d.text((cx, top - 16), g['text'], font=f_name, fill=ink, anchor='ms')
        geo.append((cx, x0, x1, inset, poly, self.T(g['fill_at']), g['pct'] / 100, tuple(g['drink'])))
    if e.get('source'):
        d.text((W / 2, H - 16), e['source']['text'], font=f_src, fill=(120, 116, 108, 255), anchor='ms')
    cache = {}

    def frame(tt):
        key = tuple(round(min(1.0, max(0.0, (tt - fa) / FILL_S)), 2) for *_, fa, _, _ in geo)
        if key in cache:
            return cache[key]
        im = card.copy()
        S = 3  # the glasses are drawn at 3x and reduced, so their edges and the water line are smooth
        lay = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
        dl = ImageDraw.Draw(lay)
        for (cx, x0, x1, inset, poly, fa, pct, drink), u in zip(geo, key):
            P = [(x * S, y * S) for x, y in poly]
            dl.polygon(P, fill=drink + (255,))
            level = L.ease_out(u) * pct
            if level > 0:  # water rises from the bottom; the glass narrows towards its foot
                yb, yt = (top + gh) * S, (top + gh - gh * level) * S
                k = lambda y: inset * S * (y - top * S) / (gh * S)
                dl.polygon([(x0 * S + k(yt), yt), (x1 * S - k(yt), yt), (x1 * S - k(yb), yb), (x0 * S + k(yb), yb)],
                           fill=WATER + (255,))
                dl.line([(x0 * S + k(yt) + S, yt), (x1 * S - k(yt) - S, yt)], fill=(196, 226, 250, 255), width=2 * S)
            dl.line(P + [P[0]], fill=(70, 74, 82, 255), width=4 * S, joint='curve')
            dl.line([(x0 * S + 10 * S, top * S + 14 * S), (x0 * S + inset * S * 0.8 + 10 * S, (top + gh) * S - 18 * S)],
                    fill=(255, 255, 255, 150), width=5 * S)  # the glass's highlight
        im.alpha_composite(lay.resize((W, H), Image.LANCZOS))
        dd = ImageDraw.Draw(im)
        for (cx, *_), u, g in zip(geo, key, e['glasses']):
            if u >= 1:
                dd.text((cx, lab_y), g['label']['text'], font=f_lab, fill=(40, 96, 156, 255), anchor='mt')
        out = L.shadow(im, look.R['card']['shadow'])
        cache[key] = out
        return out
    full, pad = frame(1e9)
    x_end, y_end = e['pos'][0] - pad, e['pos'][1] - pad
    self.safe_box(e.get('id', 'glasses'), *self.opaque_box(full, x_end, y_end), t_in, t_out)
    side = L.slide_side(e, x_end, full.width)

    def dyn(tt):
        im, _ = frame(min(max(tt, t_in), t_out))
        x = L.slide_x(tt, t_in, t_out, x_end, im.width, side)
        if x is None:
            return None, 0, 0
        return im, x, y_end
    sp = kit.SmoothSprite(self, e.get('id', 'glasses'), None, 0, 0, t_in, 'none', 0, order=e.get('order', 55), jitter=False)
    sp.dynamic = L.blur_moves(dyn)
    self.add(sp)
    self.sound('card_in', t_in)
    for *_, fa, _, _ in geo:
        self.sound('marker', fa)
    self.sound('card_out', t_out)
