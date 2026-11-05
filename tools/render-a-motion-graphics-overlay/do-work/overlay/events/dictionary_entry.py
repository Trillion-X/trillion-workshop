"""dictionary-entry: his coined term set as a dictionary clipping (headword, part of speech, a numbered definition in his own
words), with a pencil line drawn under one phrase on the word that says it, and pencil notes added in the margin as he gives
examples (the reader's own marks on the page, like notes in a book).

Spec: {type: dictionary, id, pos: [x, y], w, rot, at, out, head, kind, sense, size,
       hl: {phrase, at, s} (pencil underline),  notes: [{text, at, size, rot}]}"""
from PIL import Image, ImageDraw
from overlay import look, stage
from overlay.helpers import marker_and_slide as L


def wrap(words, fnt, width):
    """Lay words into lines no wider than width; returns [(word, x, line_index)] and the line count."""
    out, x, line = [], 0.0, 0
    sp = fnt.getlength(' ')
    for wd in words:
        wl = fnt.getlength(wd)
        if x > 0 and x + wl > width:
            x, line = 0.0, line + 1
        out.append((wd, x, line))
        x += wl + sp
    return out, line + 1


def ev_dictionary(self, e):
    W = e['w']
    size = e.get('size', 30)
    f_head = L.face('DMSerifDisplay-Regular.ttf', int(size * 1.9))
    f_kind = L.face('SpecialElite-Regular.ttf', int(size * 0.8))
    f_body = L.face('DMSerifDisplay-Regular.ttf', size)
    f_note = L.face('Kalam-Bold.ttf', int(size * 0.9))
    pad = int(size * 1.1)
    lh = int(size * 1.38)
    laid, n_lines = wrap(e['sense'].split(' '), f_body, W - 2 * pad - size * 1.2)
    head_h = int(size * 2.4)
    notes = e.get('notes', [])
    note_h = int(size * 1.3) * len(notes)
    H = pad + head_h + int(size * 1.2) + n_lines * lh + (int(size * 0.6) + note_h if notes else 0) + pad
    self.seed += 1
    base = L.paper(W, H, 'aged', self.seed, edge_amp=4, step=8)
    d = ImageDraw.Draw(base)
    ink = L.col('ink') + (255,)
    d.text((pad, pad), e['head'], font=f_head, fill=ink)
    y_kind = pad + head_h
    d.text((pad, y_kind), e['kind'], font=f_kind, fill=(90, 84, 74, 255))
    y0 = y_kind + int(size * 1.2)
    x0 = pad + size * 1.2
    d.text((pad, y0), '1.', font=f_body, fill=ink)
    # the underlined phrase: its words' boxes, one per line it spans
    hl = e.get('hl')
    hl_rects = []
    if hl:
        ph = hl['phrase'].split(' ')
        ws = [wd for wd, _, _ in laid]
        k = next(i for i in range(len(ws)) if ws[i:i + len(ph)] == ph)
        span = laid[k:k + len(ph)]
        for ln in sorted({l for _, _, l in span}):
            on = [(wd, x) for wd, x, l in span if l == ln]
            xa = x0 + on[0][1] - 6
            xb = x0 + on[-1][1] + f_body.getlength(on[-1][0]) + 6
            hl_rects.append((xa, y0 + ln * lh + size * 0.12, xb - xa, int(size * 1.02)))
    text_layer = Image.new('RGBA', base.size, (0, 0, 0, 0))
    td = ImageDraw.Draw(text_layer)
    for wd, x, ln in laid:
        td.text((x0 + x, y0 + ln * lh), wd, font=f_body, fill=ink)
    y_notes = y0 + n_lines * lh + int(size * 0.6)
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    t_hl = self.T(hl['at']) if hl else None
    hl_s = hl.get('s', 1.1) if hl else 0
    note_t = [self.T(n['at']) for n in notes]
    cache = {}

    def card(tt):
        u = 0.0 if t_hl is None or tt < t_hl else min(1.0, L.ease_in_out((tt - t_hl) / hl_s, 1.3))
        n_on = sum(1 for t in note_t if tt >= t)
        key = (round(u, 2), n_on)
        if key in cache:
            return cache[key]
        im = base.copy()
        im.alpha_composite(text_layer)
        dd = ImageDraw.Draw(im)
        if u > 0:  # the pencil line runs under each line of the phrase in turn, left to right
            left = u * sum(r[2] for r in hl_rects)
            for k, (bx, by, bw, bh) in enumerate(hl_rects):
                show = min(bw, max(0.0, left))
                left -= bw
                if show > 2:
                    yy = by + bh + 2
                    L.marker_line(dd, [(bx + 4, yy + 1), (bx + 4 + show * 0.5, yy - 1), (bx + show - 4, yy + 2)], (64, 64, 70, 255), 3, seed=20 + k)
        for i in range(n_on):
            dd.text((x0, y_notes + i * int(size * 1.3)), notes[i]['text'], font=f_note, fill=(70, 70, 74, 255))
        out = L.shadow(im.rotate(-e.get('rot', 0), expand=True, resample=Image.BICUBIC), look.R['card']['shadow'])
        cache[key] = out
        return out
    full, pad_s = card(t_out - 0.01)
    x_end, y_end = e['pos'][0] - pad_s, e['pos'][1] - pad_s
    self.safe_box(e.get('id', 'dict'), *self.opaque_box(full, x_end, y_end), t_in, t_out)
    side = L.slide_side(e, x_end, full.width)

    def dyn(tt):
        im, _ = card(tt)
        x = L.slide_x(tt, t_in, t_out, x_end, im.width, side)
        if x is None:
            return None, 0, 0
        return im, x, y_end
    sp = stage.Sprite(e.get('id', 'dict'), None, 0, 0, t_in, 'none', 0, order=e.get('order', 55), jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('card_in', t_in)
    if t_hl is not None:
        self.sound('pencil', t_hl)
    for t in note_t:
        self.sound('pencil', t)
    self.sound('card_out', t_out)
