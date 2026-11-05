"""The `letters` event. Ported from filmcraft/options-ch1/tools-round-3/r3.py:352."""
import numpy as np
from PIL import Image, ImageDraw

from overlay import kit, look, stage


# ---------- collage letters ----------
def ev_letters(self, e):
    """Each letter on its own scrap of a different paper, in a different face, set down one after another."""
    rng = np.random.default_rng(e.get('seed', 4))
    faces, papers = e.get('faces', look.LOOK3['letter_faces']), e.get('papers', look.LOOK3['letter_papers'])
    x = e['pos'][0]
    t0 = self.T(e['at'])
    k = 0
    for ch in e['text']:
        if ch == ' ':
            x += e['size'] * 0.35
            continue
        fnt = kit.face(faces[k % len(faces)], e['size'] * rng.uniform(0.86, 1.1))
        paper = papers[k % len(papers)]
        bb = fnt.getbbox(ch)
        px, py = int(e['size'] * 0.16), int(e['size'] * 0.12)
        w, h = int(bb[2] - bb[0] + 2 * px), int(bb[3] - bb[1] + 2 * py)
        mask = Image.new('L', (w, h), 0)
        ImageDraw.Draw(mask).polygon(stage.torn_polygon(w, h, 3, int(rng.integers(1e6)), step=7), fill=255)
        if paper in ('white', 'black'):
            piece = Image.new('RGBA', (w, h), (stage.rgb('paper_white') if paper == 'white' else (28, 27, 25)) + (255,))
            piece = stage.apply_texture(piece, 'crumpled', int(rng.integers(1e6)), 0.4)
            piece.putalpha(mask)
            piece, _ = stage.shadowed(piece, {'dx': 2, 'dy': 5, 'blur': 9, 'opacity': 0.32})
        else:
            piece = self.collage_piece(mask, paper, int(rng.integers(1e6)))
        inkc = (250, 248, 240) if paper == 'black' else kit.col('ink')
        off = (piece.width - w) / 2
        ImageDraw.Draw(piece).text((off + px - bb[0], off + py - bb[1]), ch, font=fnt, fill=inkc + (255,))
        piece = piece.rotate(rng.uniform(-6, 6), expand=True, resample=Image.BICUBIC)
        t = t0 + k * e.get('stagger_s', 0.07)
        y = e['pos'][1] + rng.uniform(-8, 8) - (piece.height - h) / 2
        px0 = x - (piece.width - w) / 2
        self.safe_box(e.get('id', 'letters'), *self.opaque_box(piece, px0, y), t)
        self.add(stage.Sprite(e.get('id', 'letters'), piece, px0, y, t, 'pop', 0.15, order=e.get('order', 80), jitter=e.get('jitter', False)))
        if k % 2 == 0:
            self.sound(['piece1', 'piece2', 'piece3'][(k // 2) % 3], t)
        x += w * 0.94
        k += 1
