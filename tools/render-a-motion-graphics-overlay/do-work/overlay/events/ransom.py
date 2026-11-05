"""The `ransom` event. Ported from narrator/tools/render_correction.py:484."""
import numpy as np
from PIL import Image, ImageDraw

from overlay import look, stage


def ev_ransom(self, e):
    rr = look.R['ransom']
    rng = np.random.default_rng(e.get('seed', 1))
    fonts = look.R['fonts']['ransom']
    size = e.get('letter_px', rr['letter_px']) * stage.K
    x = e['pos'][0] * stage.K
    t0 = self.T(e['at'])
    k = 0
    for ch in e['text']:
        if ch == ' ':
            x += size * 0.45
            continue
        fspec = fonts[int(rng.integers(len(fonts)))]
        fnt = stage.font(fspec, size * rng.uniform(0.82, 1.12), weight=800 if 'InterTight' in fspec else None)
        paper = rr['scrap_papers'][int(rng.integers(len(rr['scrap_papers'])))]
        ink = stage.rgb('paper_white') if paper in ('ink', 'role_green') else stage.rgb('ink')
        bb = fnt.getbbox(ch)
        gw, gh = bb[2] - bb[0], bb[3] - bb[1]
        px_, py_ = rng.uniform(*rr['pad_px']) * stage.K, rng.uniform(*rr['pad_px']) * stage.K
        w, h = int(gw + 2 * px_), int(gh + 2 * py_)
        img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        fill = stage.rgb(stage.PAL.get(paper, stage.PAL['paper_white'])) if paper != 'newsprint' else (226, 222, 214)
        d.polygon(stage.torn_polygon(w, h, 3 * stage.K, int(rng.integers(1e6)), step=8 * stage.K), fill=fill + (255,))
        d.text((px_ - bb[0], py_ - bb[1]), ch, font=fnt, fill=ink + (255,))
        tex = {'kraft': 'kraft', 'newsprint': 'newsprint'}.get(paper, 'crumpled')
        img = stage.apply_texture(img, tex, int(rng.integers(1e6)), 0.45)
        img = img.rotate(rng.uniform(-rr['rot_deg'], rr['rot_deg']), expand=True, resample=Image.BICUBIC)
        img, pad = stage.shadowed(img, {'dx': 3, 'dy': 5, 'blur': 6, 'opacity': 0.4})
        yy = e['pos'][1] * stage.K + rng.uniform(-12, 12) * stage.K - pad
        tt = t0 + k * rr['stagger_s']
        self.add(stage.Sprite(e.get('id', 'ransom'), img, x - pad, yy, tt, 'slam', 0.1, order=70))
        self.sound(['pop', 'pop2', 'pop3'][k % 3], tt)
        x += w * 0.92
        k += 1
