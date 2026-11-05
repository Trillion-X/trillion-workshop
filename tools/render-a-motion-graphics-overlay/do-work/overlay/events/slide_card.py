"""slide_card (lane slides, carousels): one still slide of a carousel, the whole page in round 8's paper look. The page is a full sheet
of backdrop paper; on it lies a ruled index card, turned a little, with the speaker's name in red marker on its head line and his
words written in marker on its rules (round 8's question_ledger card: Kalam on a white index card, red head, text-colour-contrast
ink on white). A cover slide (cover: true) carries the title on a torn white sheet in a bigger hand, with a red marker underline
and the name under it. The words are sized to the largest of `sizes` whose lines fit the card inside the title-safe area; when
none fits the render stops (a slide never shrinks its words past the smallest size). `fit_with` (the carousel's other body texts) makes
the size one for the whole carousel: the largest size every one of them fits at, so no slide's words are smaller than its neighbours'.
The lines are then balanced: the wrap width
narrows while the line count holds, so no last line is one word left alone. The name is the same size on every slide of a
carousel (LABEL_PX, COVER_LABEL_PX), whatever size its words take. Drawn once and held: a still, rendered by
r3.py --stills at a spec `canvas` such as [1080, 1350].

    {"type": "slide_card", "id": "slide", "text": "...", "label": "the speaker's name", "cover": false,
     "backdrop": "kraft" | "cream", "sizes": [76, 70, 64, 58, 52, 46], "fit_with": ["...", ...], "rot": -1.0}
"""
import os
import sys

from PIL import Image, ImageDraw
from overlay import kit, look, stage
from overlay.kit import SAFE, face

from overlay.helpers import paper_pieces as K

FACE = 'Kalam-Bold.ttf'
MARGIN = 48           # page paper kept clear round the card, inside the title-safe area
PAD, LEFT = 44, 70    # the card's inner top/bottom padding, and the written lines' left edge (right of the margin rule)
BODY_SIZES = [76, 70, 64, 58, 52, 46]
COVER_SIZES = [112, 104, 96, 88, 80, 72]
LABEL_PX, COVER_LABEL_PX = 46, 50
BALANCE_STEP_PX = 8


def balanced(text, fnt, width):
    """The wrapped lines at the narrowest width (BALANCE_STEP_PX at a time) that still takes as few lines as width does."""
    lines, _ = K.text_layout(text, fnt, width)
    while width > BALANCE_STEP_PX:
        narrower, _ = K.text_layout(text, fnt, width - BALANCE_STEP_PX)
        if len(narrower) > len(lines) or max(fnt.getlength(line) for line in narrower) > width - BALANCE_STEP_PX:
            return lines
        lines, width = narrower, width - BALANCE_STEP_PX
    return lines


def fit(text, sizes, width, height, spacing):
    """(size, balanced lines, line height) for the largest size whose wrapped lines fit width x height."""
    for size in sizes:
        fnt = face(FACE, size)
        lines, _ = K.text_layout(text, fnt, width)
        asc, desc = fnt.getmetrics()
        lh = int((asc + desc) * spacing)
        if lh * len(lines) <= height and max(fnt.getlength(line) for line in lines) <= width:
            return size, balanced(text, fnt, width), lh
    raise SystemExit(f'slide_card: "{text[:40]}..." does not fit {width}x{height} at {sizes[-1]} px')


def index_card(self, e, w, room_h):
    """The ruled card: name on the head line, the words on the rules below it."""
    head = K.hand(e['label'], FACE, LABEL_PX, K.RED)
    width, height = w - LEFT - PAD, room_h - 2 * PAD - head.height - 12
    # one size for the whole carousel: the largest every text in fit_with (and this one) fits at
    size = min(fit(text, e.get('sizes', BODY_SIZES), width, height, 1.25)[0] for text in [e['text'], *e.get('fit_with', [])])
    size, lines, lh = fit(e['text'], [size], width, height, 1.25)
    head_h = head.height + 12
    h = PAD + head_h + lh * len(lines) + PAD
    self.seed += 1
    card = K.paper(w, h, 'index', self.seed, edge='straight', rules=(PAD + head_h - 4, lh))
    card.alpha_composite(head, (LEFT, PAD - 6))
    fnt = face(FACE, size)
    asc, _ = fnt.getmetrics()
    d = ImageDraw.Draw(card)
    for i, line in enumerate(lines):
        base = PAD + head_h + lh * (i + 1) - 6  # each line sits on its blue rule
        d.text((LEFT, base - asc), line, font=fnt, fill=K.INK + (255,))
    return card


def cover_sheet(self, e, w, room_h):
    """The title on a torn white sheet, a red marker stroke under it, the name below."""
    name = K.hand(e['label'], FACE, COVER_LABEL_PX, K.RED)
    size, lines, lh = fit(e['text'], e.get('sizes', COVER_SIZES), w - 2 * PAD - 20, room_h - 2 * PAD - 80 - name.height, 0.98)
    title = K.hand('\n'.join(lines), FACE, size, spacing=0.98)
    under_w = int(min(title.width, w - 2 * PAD) * 0.62)
    h = PAD + title.height + 34 + 16 + 30 + name.height + PAD
    self.seed += 1
    sheet = K.paper(w, h, 'white', self.seed, edge='torn')
    x0 = (w - title.width) // 2
    sheet.alpha_composite(title, (x0, PAD))
    y = PAD + title.height + 14
    K.highlight_onto(sheet, ((w - under_w) // 2, y, (w + under_w) // 2, y + 22), 'red', 1.0, self.seed)
    sheet.alpha_composite(name, ((w - name.width) // 2, y + 22 + 30))
    return sheet


def ev_slide_card(self, e):
    sid = e.get('id', 'slide')
    self.seed += 1
    page = K.paper(stage.W, stage.H, e.get('backdrop', 'kraft'), self.seed, edge='straight')
    w = stage.W - 2 * (SAFE + MARGIN)
    room_h = stage.H - 2 * (SAFE + MARGIN)
    piece = (cover_sheet if e.get('cover') else index_card)(self, e, w, room_h)
    piece = piece.rotate(-e.get('rot', -1.0), expand=True, resample=Image.BICUBIC)
    shown, pad = K.shadow(piece)
    x, y = (stage.W - piece.width) // 2, (stage.H - piece.height) // 2
    page.alpha_composite(shown, (x - pad, y - pad))
    self.safe_box(sid, x, y, x + piece.width, y + piece.height)
    self.add(stage.Sprite(sid, page, 0, 0, 0.0, 'none', 0, order=e.get('order', 10), jitter=False))
