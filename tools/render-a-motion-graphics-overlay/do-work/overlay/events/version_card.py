"""version-card-line-pull: a recipe index card, "version 1", listing what went in. On the word that names the next version the
number is crossed out in pencil and the new number written beside it; on the word that drops an ingredient, that line is
pulled out of the card sideways, off the frame by the card's own side edge, so it never crosses him and the lines below close the gap. The card slides out when he
moves on. The card stays square to the frame so the pulled line leaves from exactly where it sat.

Spec: {type: version, id, pos: [x, y], size: [w, h], at, out, title: [before, old_n, new_n], renumber_at,
       lines: [...], pull: {line, at}, text_px, title_font, query: {line, at} (round 2: a pencil "?" written after that line on the
       word that questions it)}"""
from PIL import Image, ImageDraw
from overlay import look, stage
from overlay.helpers import marker_and_slide as L


def ev_version(self, e):
    w, h = e['size']
    px = e.get('text_px', 40)
    f_t = L.face(e.get('title_font', 'Kalam-Bold.ttf'), px)  # round 2: CaveatBrush, whose 1 cannot be read as an l
    f_l = L.face('CourierPrime-Bold.ttf', int(px * 0.9))
    self.seed += 1
    base = L.paper(w, h, 'index', self.seed, edge_amp=1, step=12)
    d = ImageDraw.Draw(base)
    top = int(px * 2.0)
    lh = int(px * 1.5)
    d.line([(0, top - 6), (w, top - 6)], fill=(214, 120, 120, 255), width=2)
    for y in range(top - 6 + lh, h - 8, lh):
        d.line([(0, y), (w, y)], fill=(176, 194, 216, 255), width=1)
    pencil = (58, 58, 62, 255)
    before, old_n, new_n = e['title']
    tx = int(px * 0.7)
    d.text((tx, top - 14), before, font=f_t, fill=pencil, anchor='ls')
    nx = tx + f_t.getlength(before + ' ')
    d.text((nx, top - 14), old_n, font=f_t, fill=pencil, anchor='ls')
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    ren_t = self.T(e['renumber_at'])
    pull_i, pull_t = e['pull']['line'], self.T(e['pull']['at'])
    line_imgs = []
    for ln in e['lines']:
        im = Image.new('RGBA', (int(f_l.getlength(ln)) + 12, int(px * 1.3)), (0, 0, 0, 0))
        ImageDraw.Draw(im).text((4, im.height - 8), ln, font=f_l, fill=L.col('ink') + (255,), anchor='ls')
        line_imgs.append(im)

    q = e.get('query')
    q_t = self.T(q['at']) if q else None
    if q:  # the questioned line with its pencil "?" after it: one image, so the "?" leaves with the line if it is pulled
        li = line_imgs[q['line']]
        q_img = Image.new('RGBA', (li.width + int(f_t.getlength(' ?')) + 8, li.height), (0, 0, 0, 0))
        q_img.alpha_composite(li, (0, 0))
        ImageDraw.Draw(q_img).text((li.width + 4, li.height - 6), '?', font=f_t, fill=pencil, anchor='ls')

    def line_img(i, tt):
        return q_img if q and i == q['line'] and tt >= q_t else line_imgs[i]

    def card(tt, with_pulled):
        im = base.copy()
        dd = ImageDraw.Draw(im)
        if tt >= ren_t:
            u = min(1.0, (tt - ren_t) / 0.25)
            ow = f_t.getlength(old_n)
            dd.line([(nx - 4, top - 14 - px * 0.05), (nx - 4 + (ow + 8) * u, top - 14 - px * 0.05 - px * 0.62 * u)], fill=pencil, width=4)
            if u >= 1:
                dd.text((nx + ow + 14, top - 14), new_n, font=f_t, fill=pencil, anchor='ls')
        for i in range(len(line_imgs)):
            li = line_img(i, tt)
            if i == pull_i and not with_pulled:
                continue
            k = float(i)
            if i > pull_i and tt >= pull_t + 0.2:
                k -= L.ease_in_out((tt - pull_t - 0.2) / 0.3, 2.0)
            im.alpha_composite(li, (int(px * 0.9), int(top - 6 + lh * (k + 1) - li.height + 4)))
        return im
    full, pad = L.shadow(card(t_in, True), look.R['card']['shadow'])
    x_end, y_end = e['pos'][0] - pad, e['pos'][1] - pad
    self.safe_box(e.get('id', 'version'), *self.opaque_box(full, x_end, y_end), t_in, t_out)
    side = L.slide_side(e, x_end, full.width)
    cache = {}

    def dyn(tt):
        key = (q is not None and tt >= q_t, tt >= ren_t, min(1.0, round((tt - ren_t) / 0.25, 1)) if tt >= ren_t else 0, tt >= pull_t,
               round(min(1.0, max(0.0, (tt - pull_t - 0.2) / 0.3)), 2))
        if key not in cache:
            cache[key] = L.shadow(card(tt, tt < pull_t), look.R['card']['shadow'])[0]
        im = cache[key]
        x = L.slide_x(tt, t_in, t_out, x_end, im.width, side)
        if x is None:
            return None, 0, 0
        return im, x, y_end
    sp = stage.Sprite(e.get('id', 'version'), None, 0, 0, t_in, 'none', 0, order=55, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    # the pulled line: leaves the card by the card's side edge, on its own, until it is off the frame
    li = line_img(pull_i, pull_t)
    lx = e['pos'][0] + px * 0.9
    ly = e['pos'][1] + top - 6 + lh * (pull_i + 1) - li.height + 4

    def pull(tt):
        v = L.ease_in((tt - pull_t) / 0.4)
        if v >= 1:
            return None, 0, 0
        return li, lx + (-v * (lx + li.width + 40) if side == 'left' else v * (stage.W - lx + 40)), ly
    sp2 = stage.Sprite(e.get('id', 'version') + '-pull', None, 0, 0, pull_t, 'none', 0, order=56, jitter=False)
    sp2.dynamic = pull
    self.add(sp2)
    self.sound('card_in', t_in)
    if q:
        self.sound('pencil', q_t)
    self.sound('pencil', ren_t)
    self.sound('word_out', pull_t)
    self.sound('card_out', t_out)
