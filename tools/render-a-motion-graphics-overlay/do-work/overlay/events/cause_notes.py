"""cause-notes: a lab-notebook page (graph paper) beside him. What he names is written in pencil, one line per word; then
pen notes give the sourced cause of one line and what can be done about it, each joined to its line by a hand-drawn
arrow that runs down the margin and turns into the note (annotation callout, awesome-ai-motion #240: the line grows from
the thing, then the note appears; 3brown1blue "narration first, then visual beats"). Colour by meaning: red for the
cause, green for the way out. A source line sits at the foot of the page.

Drawn on twos like the other paper pieces (no motion blur); the page slides in and out by its nearer side edge.

Spec: {type: causes, id, pos: [x, y], size: [w, h], at, out, font, text_px, head: {text, at}, items: [{text, at}],
       notes: [{text, at, colour: red|green, item}], source: {text}}"""
from PIL import Image, ImageDraw
from overlay import look, stage
from overlay.helpers import marker_and_slide as L

PEN = {'red': (196, 40, 36, 255), 'green': (38, 128, 62, 255)}
DRAW_S = 0.35  # the arrow grows in this long, then its note is written


def wrap(text, font, width):
    lines, cur = [], ''
    for w in text.split():
        nxt = (cur + ' ' + w).strip()
        if font.getlength(nxt) > width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = nxt
    return lines + [cur]


WRITE_S, NOTE_S = 0.5, 0.9  # pencil lines and pen notes are written on left to right (on twos: 6 steps), never popped in


def step(t0, tt, dur):
    return 0.0 if tt < t0 else min(1.0, round((tt - t0) / dur * 6) / 6)


def write(im, xy, text, font, ink, anchor, u):
    """Draw text onto im, only its left fraction u (a pen moving left to right)."""
    lay = Image.new('RGBA', im.size, (0, 0, 0, 0))
    ImageDraw.Draw(lay).text(xy, text, font=font, fill=ink, anchor=anchor)
    if u < 1:
        lay = lay.crop((0, 0, int(xy[0] + font.getlength(text) * u) + 1, lay.height))
    im.alpha_composite(lay, (0, 0))


def ev_causes(self, e):
    W, H = e['size']
    px = e.get('text_px', 38)
    fnt = L.face(e.get('font', 'CaveatBrush-Regular.ttf'), px)
    f_note = L.face(e.get('note_font', 'Kalam-Bold.ttf'), int(px * 0.68))
    f_src = L.face('CourierPrime-Bold.ttf', 18)
    pencil = (58, 58, 62, 255)
    self.seed += 1
    base = L.paper(W, H, 'white', self.seed, edge_amp=1, step=12)
    d = ImageDraw.Draw(base)
    for gx in range(0, W, 24):  # the notebook's graph grid
        d.line([(gx, 0), (gx, H)], fill=(206, 222, 236, 255), width=1)
    for gy in range(0, H, 24):
        d.line([(0, gy), (W, gy)], fill=(206, 222, 236, 255), width=1)
    if e.get('source'):
        d.text((W / 2, H - 14), e['source']['text'], font=f_src, fill=(120, 116, 108, 255), anchor='ms')
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    lh = int(px * 1.25)
    x_item, x_margin = 66, 26
    y_head = int(px * 1.2)
    y_items = [y_head + lh * (k + 1) for k in range(len(e['items']))]
    note_px = int(px * 0.68 * 1.25)
    y = y_items[-1] + int(lh * 0.55)
    notes = []
    for nt in e.get('notes', []):
        lines = wrap(nt['text'], f_note, W - x_item - 30)
        notes.append((self.T(nt['at']), lines, y, PEN[nt.get('colour', 'red')], nt.get('item', 0)))
        y += note_px * len(lines) + 14
    head_t = self.T(e['head']['at']) if e.get('head') else None
    item_t = [self.T(it['at']) for it in e['items']]
    cache = {}

    def page(tt):
        key = (step(head_t, tt, WRITE_S) if head_t is not None else 0.0, tuple(step(t, tt, WRITE_S) for t in item_t),
               tuple(round(min(1.0, max(0.0, (tt - nt[0]) / DRAW_S)), 1) if tt >= nt[0] else -1 for nt in notes),
               tuple(step(nt[0] + DRAW_S, tt, NOTE_S) for nt in notes))
        if key in cache:
            return cache[key]
        im = base.copy()
        dd = ImageDraw.Draw(im)
        if key[0] > 0:
            write(im, (x_margin, y_head), e['head']['text'], fnt, pencil, 'ls', key[0])
        for k, u in enumerate(key[1]):
            if u > 0:
                write(im, (x_item, y_items[k]), '– ' + e['items'][k]['text'], fnt, pencil, 'ls', u)
        for k, ((t0, lines, ny, ink, item), u, w) in enumerate(zip(notes, key[2], key[3])):
            if u < 0:
                continue
            # the arrow: from under its line, down the margin, turning right into the note; a second note on the same line
            # runs its arrow a little further in, so the two never draw over each other
            y0 = y_items[item] + 8
            y1 = ny + note_px * 0.5
            xm = x_margin + 9 * k
            pts = [(x_item - 18 + 6 * k, y0), (xm - 6, y0 + 16), (xm - 8, y1 - 18), (xm + 2, y1), (x_item - 10, y1)]
            pts = L.catmull(pts, n=10)
            cum = L.polyline_length(pts)
            part = L.polyline_prefix(pts, cum, cum[-1] * u)
            if len(part) > 1:
                dd.line(part, fill=ink, width=4, joint='curve')
            if u >= 1:
                ax, ay = x_item - 10, y1
                dd.polygon([(ax + 2, ay), (ax - 12, ay - 8), (ax - 12, ay + 8)], fill=ink)
                total = sum(f_note.getlength(ln) for ln in lines)  # the note is written on line after line
                for j, ln in enumerate(lines):
                    before = sum(f_note.getlength(x) for x in lines[:j])
                    frac = min(1.0, max(0.0, (w * total - before) / max(1.0, f_note.getlength(ln))))
                    if frac > 0:
                        write(im, (x_item, ny + note_px * (j + 0.5)), ln, f_note, ink, 'lm', frac)
        out = L.shadow(im, look.R['card']['shadow'])
        cache[key] = out
        return out
    full, pad = page(1e9)
    x_end, y_end = e['pos'][0] - pad, e['pos'][1] - pad
    self.safe_box(e.get('id', 'causes'), *self.opaque_box(full, x_end, y_end), t_in, t_out)
    side = L.slide_side(e, x_end, full.width)

    def dyn(tt):
        im, _ = page(tt)
        x = L.slide_x(tt, t_in, t_out, x_end, im.width, side)
        if x is None:
            return None, 0, 0
        return im, x, y_end
    sp = stage.Sprite(e.get('id', 'causes'), None, 0, 0, t_in, 'none', 0, order=e.get('order', 55), jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('card_in', t_in)
    pk = e.get('pencil_kinds', ['pencil'])  # a different pencil take per line, so no take repeats as a loop
    for k, t in enumerate(([head_t] if head_t is not None else []) + item_t):
        self.sound(pk[k % len(pk)], t)
    for t0, *_ in notes:
        self.sound('brush', t0)
    self.sound('card_out', t_out)
