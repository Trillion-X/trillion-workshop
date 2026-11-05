"""document-zoom: the real first page of a paper on a white sheet beside him; the view inside the sheet pushes in to one line
(zoom to detail, awesome-ai-motion #223, MIT: re-centre on the target and scale about 2.6x over 1.75 s, power2.inOut), then a
highlighter band sweeps behind that line on the word that says it (#089). Every frame is drawn (smooth camera); the sheet
slides in and out like the other cards. A source line in ink sits on the sheet's bottom margin.

Spec: {type: doczoom, id, pos: [x, y] sheet top-left, size: [w, h], page: png, at, out,
       views: [{at, cx, cy, width, move_s, curve, sound}]   page px: the region shown, centred on (cx, cy), `width` page px
                                           across; the move to a view starts on its `at` and takes move_s; curve 'inout'
                                           (default) or 'out' (a purposeful camera move: quick start, settles); sound: a
                                           sound kind played as the move starts,
       hl: [{rect: [x0, y0, x1, y1] page px, at, s} | {rects: [[x0, y0, x1, y1], ...], at, s, colour}],  source: text}

A highlight with `colour` (green good, yellow neutral, red bad) is a real highlighter stroke (ch4lib.marker_highlight) drawn
across its rects one line after another within s; one without is round 1's flat band."""
from PIL import Image, ImageDraw
from overlay import kit
from overlay import look
from overlay.helpers import marker_and_slide as L


def ev_doczoom(self, e):
    W, H = e['size']
    page = Image.open(e['page']).convert('RGBA')
    margin = 18
    src_h = 46 if e.get('source') else 0
    vw, vh = W - 2 * margin, H - 2 * margin - src_h
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    views = [(self.T(v['at']), v['cx'], v['cy'], v['width'], v.get('move_s', 1.75), v.get('curve', 'inout')) for v in e['views']]
    strokes = []  # (start, seconds, x, y, band): one per highlighted line, in order
    for i, h in enumerate(e.get('hl', [])):
        t0, s = self.T(h['at']), h.get('s', 1.2)
        if 'colour' not in h:
            r = h['rect']
            strokes.append((t0, s, r[0], r[1], L.highlighter_band(int(r[2] - r[0]), int(r[3] - r[1]), 80 + i, alpha=0.4)))
            continue
        total = sum(r[2] - r[0] for r in h['rects'])
        for k, r in enumerate(h['rects']):
            band, pad = L.marker_highlight(int(r[2] - r[0]), int(r[3] - r[1]), 80 + 10 * i + k, h['colour'])
            strokes.append((t0, s * (r[2] - r[0]) / total, r[0], r[1] - pad, band))
            t0 += s * (r[2] - r[0]) / total
    sheet = L.paper(W, H, 'white', 7, edge_amp=0, step=20)
    if e.get('source'):  # the whole source line on the sheet: the face steps down until it fits the margin
        px = 22
        while px > 12 and L.face('CourierPrime-Bold.ttf', px).getlength(e['source']) > W - 2 * margin - 8:
            px -= 1
        ImageDraw.Draw(sheet).text((margin + 4, H - margin - src_h / 2), e['source'], font=L.face('CourierPrime-Bold.ttf', px),
                                   fill=L.col('ink') + (255,), anchor='lm')

    def view_at(tt):
        """Hold each view; the move to the next view starts on its `at` and takes its move_s (default 1.75 s)."""
        cur = views[0][1:4]
        for at, cx, cy, width, move_s, curve in views[1:]:
            if tt < at:
                break
            x = min(1.0, max(0.0, (tt - at) / move_s))
            u = 1 - (1 - x) ** 3 if curve == 'out' else L.ease_in_out(x, 2.0)
            cur = tuple(a + (b - a) * u for a, b in zip(cur, (cx, cy, width)))
        return cur
    lit = {}

    def lit_page(tt):
        fr = tuple(round(min(1.0, L.ease_in_out((tt - t0) / s, 1.3)), 2) if tt >= t0 else 0.0 for t0, s, _, _, _ in strokes)
        if fr not in lit:
            pg = page.copy()
            for f, (_, _, x0, y0, band) in zip(fr, strokes):
                if f > 0:
                    pg = L.multiply(pg, band.crop((0, 0, max(1, int(band.width * f)), band.height)), (x0, y0))
            lit.clear()
            lit[fr] = pg
        return lit[fr]

    def sheet_at(tt):
        cx, cy, width = view_at(tt)
        s = width / vw
        box = (cx - width / 2, cy - vh * s / 2, cx + width / 2, cy + vh * s / 2)
        crop = lit_page(tt).crop(tuple(int(round(v)) for v in box)).resize((vw, vh), Image.LANCZOS)
        im = sheet.copy()
        im.alpha_composite(crop, (margin, margin))
        ImageDraw.Draw(im).rectangle([margin, margin, margin + vw - 1, margin + vh - 1], outline=(214, 212, 206, 255), width=1)
        return L.shadow(im, look.R['card']['shadow'])
    full, pad = sheet_at(t_out - 0.01)
    x_end, y_end = e['pos'][0] - pad, e['pos'][1] - pad
    self.safe_box(e.get('id', 'doc'), *self.opaque_box(full, x_end, y_end), t_in, t_out)
    side = L.slide_side(e, x_end, full.width)

    def dyn(tt):
        im, _ = sheet_at(min(max(tt, t_in), t_out))
        x = L.slide_x(tt, t_in, t_out, x_end, im.width, side)
        if x is None:
            return None, 0, 0
        return im, x, y_end
    sp = kit.SmoothSprite(self, e.get('id', 'doc'), None, 0, 0, t_in, 'none', 0, order=e.get('order', 55), jitter=False)
    sp.dynamic = L.blur_moves(dyn)  # round 2: the sheet's slides carry motion blur (the person's rules motion-blur-fits-style)
    self.add(sp)
    self.sound('card_in', t_in)
    for v, (at, *_rest) in zip(e['views'][1:], views[1:]):
        if v.get('sound'):
            self.sound(v['sound'], at)
    for h in e.get('hl', []):
        self.sound(h.get('sound', 'marker'), self.T(h['at']))
    self.sound('card_out', t_out)
