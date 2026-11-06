"""citation_card (lane ch3): Vox-style press citations. A hard cut to a textured desk; real screenshots of real articles,
cut out as paper clippings (outlet, headline and date from the page itself, then the quoted paragraph), are laid on the desk
one after another while his voice plays on; one camera pushes in to each clipping's quoted lines and then holds still;
on his words a real highlighter stroke (kit highlight_onto: chisel ends, uneven edges, multiplied into the page so the
words stay black) is written over the exact words, found on the screenshot by tesseract OCR. A small tape tab names the
year. Hard cut back to him at `until` (techniques: article highlight, Liamrjohnston/remotion-motion-graphics-skill
article-highlights; animated screenshot card with drop shadow, Justin Odisho; flat-safe push-in, Alisa0808/vox-director;
highlighter sweep #089, awesome-ai-motion).

    {"type": "citation_card", "id": "cite", "at": s, "until": s, "desk": "board",
     "cards": [{"id": "fn", "at": s, "pos": [cx, cy], "scale": 0.85, "rot": -1.2, "label": "Jan 2019", "tab_side": "left",
                "parts": [{"image": png, "crop": [x0, y0, x1, y1]}, ...],          stacked top to bottom, left aligned
                "marks": [{"text": "methylcellulose", "part": 1, "colour": "red", "at": s, "nth": 0}, ...]}],
     "camera": [{"at": s, "zoom": 1.0, "center": [x, y]}, ...]}                   desk pixels; 0.8 s eased moves, then still

`text` of a mark is the exact words on the page (the fact gate checks them against the cited source). Every clipping is
drawn every frame from the screenshot's own pixels (no upscaling past 1.35x at rest), so the page text stays sharp."""
import os
import re
import subprocess
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from overlay import stage
from overlay.kit import SmoothSprite
from overlay.stage import FPS
from overlay.helpers import paper_pieces as K

GAP = 26        # white space between parts of one clipping (native px)
MARGIN = 34     # white border of a clipping (native px)
MOVE_S = 0.8    # one camera move
LAND_S = 0.24   # a clipping laid down: from 1.05x with a lifted shadow to rest


def ocr_words(im):
    """[(text, line_key, x0, y0, x1, y1)] in im's pixels, read by tesseract at 2x."""
    big = im.convert('L').resize((im.width * 2, im.height * 2), Image.LANCZOS)
    tmp = f'/tmp/citation_ocr_{os.getpid()}'
    big.save(tmp + '.png')
    # run from /tmp: leptonica failed to read the image when started from the tools folder (observed 2026-10-21)
    r = subprocess.run(['tesseract', tmp + '.png', tmp, '--psm', '6', 'tsv'], capture_output=True, cwd='/tmp')
    if r.returncode:
        raise SystemExit(f'citation_card: tesseract failed: {r.stderr.decode(errors="replace")[-400:]}')
    out = open(tmp + '.tsv').read()
    for ext in ('.png', '.tsv'):
        os.remove(tmp + ext)
    words = []
    for row in out.splitlines()[1:]:
        f = row.split('\t')
        if len(f) == 12 and f[0] == '5' and f[11].strip():
            x, y, w, h = (int(v) / 2 for v in f[6:10])
            words.append((f[11], (f[2], f[3], f[4]), x, y, x + w, y + h))
    return words


def norm(t):
    return re.sub(r'[^a-z0-9]', '', t.lower())


def phrase_boxes(words, text, nth=0):
    """One box per line the phrase runs across (a stroke per line, as a hand would mark it)."""
    want = [norm(t) for t in text.split() if norm(t)]
    toks = [norm(w[0]) for w in words]
    hits = [i for i in range(len(toks) - len(want) + 1) if toks[i:i + len(want)] == want]
    if len(hits) <= nth:
        raise SystemExit(f'citation_card: "{text}" not found by OCR (read: {" ".join(w[0] for w in words)[:300]})')
    run = words[hits[nth]:hits[nth] + len(want)]
    boxes = []
    for w in run:
        if boxes and boxes[-1][0] == w[1]:
            k, x0, y0, x1, y1 = boxes[-1]
            boxes[-1] = (k, x0, min(y0, w[3]), w[4], max(y1, w[5]))
        else:
            boxes.append((w[1], w[2], w[3], w[4], w[5]))
    return [b[1:] for b in boxes]


def clipping(card):
    """The clipping in native pixels and its marks as [(boxes, colour, at, seed)] in clipping pixels."""
    parts = []
    for p in card['parts']:
        im = Image.open(p['image']).convert('RGB')
        parts.append(im.crop(tuple(p['crop'])) if p.get('crop') else im)
    w = max(p.width for p in parts) + 2 * MARGIN
    h = sum(p.height for p in parts) + GAP * (len(parts) - 1) + 2 * MARGIN
    page = Image.new('RGBA', (w, h), (255, 255, 255, 255))
    tops, y = [], MARGIN
    for p in parts:
        page.paste(p, (MARGIN, y))
        tops.append(y)
        y += p.height + GAP
    ocr = {}
    marks = []
    for k, m in enumerate(card.get('marks', [])):
        i = m.get('part', 0)
        if i not in ocr:
            ocr[i] = ocr_words(parts[i])
        boxes = [(x0 + MARGIN - 7, y0 + tops[i] - 5, x1 + MARGIN + 7, y1 + tops[i] + 6)
                 for x0, y0, x1, y1 in phrase_boxes(ocr[i], m['text'], m.get('nth', 0))]
        marks.append((boxes, m.get('colour', 'red'), m['at'], k + 3))
    # a clipping is cut with scissors: a slightly uneven straight edge, not a torn one
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).polygon(stage.torn_polygon(w, h, 1, len(card['parts']) * 7 + w, step=40), fill=255)
    page.putalpha(mask)
    page = stage.apply_texture(page, 'sheet', w % 17, 0.12)
    return page, marks


def tab(text):
    """A strip of paper tape with the year on it."""
    t = K.hand(text, '/Library/Fonts/SF-Pro-Display-Heavy.otf', 44)
    im = Image.new('RGBA', (t.width + 44, t.height + 18), (246, 222, 120, 236))
    im = stage.apply_texture(im, 'sheet', 5, 0.2)
    im.alpha_composite(t, (22, 6))
    m = Image.new('L', im.size, 0)
    ImageDraw.Draw(m).polygon(stage.torn_polygon(im.width, im.height, 2, 11, step=6), fill=255)
    im.putalpha(Image.fromarray((np.asarray(m) * (np.asarray(im.getchannel('A')) / 255)).astype(np.uint8)))
    return im


def eased(u):
    u = min(1.0, max(0.0, u))
    return u * u * u * (u * (6 * u - 15) + 10)  # smootherstep: starts and lands without a jolt


def ev_citation_card(self, e):
    W, H = stage.W, stage.H
    desk = Image.new('RGBA', (W, H), (58, 60, 64, 255))
    desk = stage.apply_texture(desk, 'kraft', 4, 0.5)
    cards = []
    for c in e['cards']:
        page, marks = clipping(c)
        marks = [(b, col, self.T(at), seed) for b, col, at, seed in marks]
        cards.append({'page': page, 'marks': marks, 'at': self.T(c['at']), 'pos': c['pos'], 'scale': c.get('scale', 0.8),
                      'rot': c.get('rot', 0.0), 'tab': tab(c['label']) if c.get('label') else None,
                      'tab_side': c.get('tab_side', 'left'), 'cache': {}})
    cam = [(self.T(k['at']), k.get('zoom', 1.0), k.get('center', [W / 2, H / 2])) for k in e['camera']]
    na, nu = round(self.T(e['at']) * FPS), round(self.T(e['until']) * FPS)

    def camera(tt):
        z, (cx, cy) = cam[0][1], cam[0][2]
        for at, z1, c1 in cam[1:]:
            u = eased((tt - at) / MOVE_S)
            if u <= 0:
                break
            z, cx, cy = z + (z1 - z) * u, cx + (c1[0] - cx) * u, cy + (c1[1] - cy) * u
        hw, hh = W / z / 2, H / z / 2  # the view never leaves the desk
        return z, min(max(cx, hw), W - hw), min(max(cy, hh), H - hh)

    def page_at(c, tt):
        fr = tuple(round(min(1.0, max(0.0, (tt - at) / (0.32 + 0.12 * len(b)))), 2) for b, _, at, _ in c['marks'])
        if fr in c['cache']:
            return c['cache'][fr]
        im = c['page'].copy()
        for (boxes, col, _, seed), f in zip(c['marks'], fr):
            left = f * sum(b[2] - b[0] for b in boxes)  # one hand: line after line, left to right
            for b in boxes:
                if left <= 0:
                    break
                L = b[2] - b[0]
                K.highlight_onto(im, b, col, min(1.0, left / L), seed)
                left -= L
        c['cache'][fr] = im
        return im

    def layer(tt):
        n = round(self.t_exact * FPS)
        if n < na or n >= nu:
            return None, 0, 0
        z, cx, cy = camera(tt)
        frame = desk.copy()
        if z != 1.0 or (cx, cy) != (W / 2, H / 2):
            vw, vh = W / z, H / z
            frame = desk.resize((W, H), Image.BILINEAR, box=(cx - vw / 2, cy - vh / 2, cx + vw / 2, cy + vh / 2))
        for c in cards:
            if tt < c['at']:
                continue
            u = min(1.0, (tt - c['at']) / LAND_S)
            lift = 1 - K.ease_out(u)
            s = c['scale'] * z * (1 + 0.05 * lift)
            pg = page_at(c, tt)
            im = pg.resize((max(1, int(pg.width * s)), max(1, int(pg.height * s))), Image.LANCZOS if s < 1 else Image.BICUBIC)
            cw, ch = im.size
            ox = oy = 0  # where the clipping sits inside the piece (the tab may stick out past its corner)
            if c['tab'] is not None:  # the year tab is taped over one top corner of the clipping
                t = c['tab'].resize((int(c['tab'].width * z), int(c['tab'].height * z)), Image.LANCZOS)
                right = c['tab_side'] == 'right'
                t = t.rotate(4 if right else -4, expand=True, resample=Image.BICUBIC)
                pad = Image.new('RGBA', (cw + t.width // 2, ch + t.height // 2), (0, 0, 0, 0))
                ox, oy = (0 if right else t.width // 2), t.height // 2
                pad.alpha_composite(im, (ox, oy))
                pad.alpha_composite(t, (cw - t.width // 2 if right else 0, 0))
                im = pad
            if c['rot']:
                w0, h0 = im.size
                im = im.rotate(-c['rot'], expand=True, resample=Image.BICUBIC)
                ox, oy = ox + (im.width - w0) / 2, oy + (im.height - h0) / 2
            # shadow: tight and dark at rest, wider and softer while the clipping is still in the air
            a = im.getchannel('A').point(lambda v: int(v * (0.5 - 0.2 * lift)))
            sh = Image.new('RGBA', im.size, (0, 0, 0, 0))
            sh.putalpha(a)
            pad = int(30 * z)
            shadow = Image.new('RGBA', (im.width + 2 * pad, im.height + 2 * pad), (0, 0, 0, 0))
            shadow.alpha_composite(sh, (pad, pad))
            shadow = shadow.filter(ImageFilter.GaussianBlur(6 * z + 14 * lift))
            # where the clipping's centre lands on screen
            px = (c['pos'][0] - cx) * z + W / 2
            py = (c['pos'][1] - cy) * z + H / 2
            x0 = px - cw / 2 - ox
            y0 = py - ch / 2 - oy
            off = int((4 + 18 * lift) * z)
            frame.alpha_composite(shadow, (int(x0 - pad + off * 0.4), int(y0 - pad + off)))
            frame.alpha_composite(im, (int(x0), int(y0)))
        return frame, 0, 0

    sp = SmoothSprite(self, e.get('id', 'cite'), None, 0, 0, (na - 0.25) / FPS, 'none', 0, order=1, jitter=False)
    sp.dynamic = layer
    self.add(sp)
    for k, c in enumerate(cards):
        self.sound('m03_page', c['at'])
        for _, _, at, _ in c['marks']:
            self.sound(f'm03_felt{1 + (k + int(at * 10)) % 3}', at)
