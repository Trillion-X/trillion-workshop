"""The `collage` event. Ported from filmcraft/options-ch1/tools-round-2/r2.py:728."""
import numpy as np
from PIL import Image, ImageDraw

from overlay import kit, look, stage


# ---------- collage header ----------
def ev_collage(self, e):
    """A header whose words are each cut from a different paper (newsprint, kraft, white, graph...), typewriter
    or SF Pro per word; the words land one after another on e.at, stagger_s apart."""
    papers = e.get('papers', ['paper_white', 'kraft', 'newsprint', 'graph'])
    fonts = e.get('fonts', ['typewriter', 'display_heavy', 'typewriter', 'display_bold'])
    x = e['pos'][0]
    t0 = self.T(e['at'])
    rng = np.random.default_rng(e.get('seed', 5))
    for k, word in enumerate(e['text'].split(' ')):
        fk = fonts[k % len(fonts)]
        size = e['size'] * (1.0 if fk != 'typewriter' else 1.12)
        fnt = stage.font(look.R['fonts']['typewriter'], size) if fk == 'typewriter' else kit.sf(fk, size)
        bb = fnt.getbbox(word)
        pw, ph = int(bb[2] - bb[0] + 26), int(bb[3] - bb[1] + 22)
        m = Image.new('L', (pw, ph), 0)
        ImageDraw.Draw(m).polygon(stage.torn_polygon(pw, ph, 3, int(rng.integers(1e6)), step=7), fill=255)
        kind = papers[k % len(papers)]
        kind = {'paper_white': 'ruled'}.get(kind, kind) if kind != 'paper_white' else 'white'
        if kind == 'white':
            piece = Image.new('RGBA', (pw, ph), stage.rgb('paper_white') + (255,))
            piece = stage.apply_texture(piece, 'crumpled', int(rng.integers(1e6)), 0.4)
            piece.putalpha(m)
            piece, _ = stage.shadowed(piece, {'dx': 2, 'dy': 5, 'blur': 9, 'opacity': 0.32})
        else:
            piece = self.collage_piece(m, kind, int(rng.integers(1e6)))
        inkc = (255, 255, 255) if kind in ('red',) else kit.col('ink')
        d = ImageDraw.Draw(piece)
        off = (piece.width - pw) / 2
        d.text((off + 13 - bb[0], off + 11 - bb[1]), word, font=fnt, fill=inkc + (255,))
        piece = piece.rotate(rng.uniform(-4, 4), expand=True, resample=Image.BICUBIC)
        t = self.T(e['times'][k]) if e.get('times') else t0 + k * e.get('stagger_s', 0.12)
        sid = e.get('id', 'collage')
        sp = stage.Sprite(sid, piece, x - (piece.width - pw) / 2, e['pos'][1] + rng.uniform(-6, 6) - (piece.height - ph) / 2, t, 'pop', 0.15, order=80, jitter=True)
        self.add(sp)
        self.sound(['piece1', 'piece2', 'piece3', 'piece1'][k % 4], t)
        x += pw * 0.96
    return x
