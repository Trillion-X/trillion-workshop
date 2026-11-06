"""still_full (lane ch2): one of his own photos full frame over the A-roll, hard cut in and out on the frame grid, with a slow
continuous drift (scale and pan) the whole time it is up so a still never reads as frozen video (technique: Ken Burns
drift; awesome-ai-motion ken-burns; filmcraft/options-ch2/techniques/still-full-frame-drift.md). His voice keeps playing; the photo only
covers the picture. Drawn every frame (no stepping on photos either: a slow drift on twos judders).

    {"type": "still_full", "id": "steak", "image": path, "crop": [x0, y0, x1, y1] (optional, source pixels),
     "at": s, "until": s, "zoom": [1.0, 1.06], "pan": [[fx0, fy0], [fx1, fy1]]}   pan: focus point (fractions) at start, end
"""
from PIL import Image, ImageOps
from overlay import kit, look, stage
from overlay.kit import SmoothSprite
from overlay.stage import FPS


def ev_still_full(self, e):
    im = ImageOps.exif_transpose(Image.open(e['image'])).convert('RGB')
    if e.get('crop'):
        im = im.crop(tuple(e['crop']))
    z0, z1 = e.get('zoom', [1.0, 1.06])
    (fx0, fy0), (fx1, fy1) = e.get('pan', [[0.5, 0.5], [0.5, 0.5]])
    na, nu = round(self.T(e['at']) * FPS), round(self.T(e['until']) * FPS)
    base = max(stage.W / im.width, stage.H / im.height)
    big = im.resize((int(im.width * base * z1 + 2), int(im.height * base * z1 + 2)), Image.LANCZOS)

    def layer(tt):
        n = round(self.t_exact * FPS)
        if n < na or n >= nu:
            return None, 0, 0
        u = (n - na) / max(1, nu - na - 1)
        u = u * u * (3 - 2 * u) * 0.5 + u * 0.5  # mostly linear, eased at both ends
        z = (z0 + (z1 - z0) * u) / z1
        w, h = stage.W / z, stage.H / z  # window in `big` pixels
        fx, fy = fx0 + (fx1 - fx0) * u, fy0 + (fy1 - fy0) * u
        x0 = min(max(fx * big.width - w / 2, 0), big.width - w)
        y0 = min(max(fy * big.height - h / 2, 0), big.height - h)
        fr = big.resize((stage.W, stage.H), Image.BILINEAR, box=(x0, y0, x0 + w, y0 + h))
        return fr.convert('RGBA'), 0, 0

    sp = SmoothSprite(self, e.get('id', 'still'), None, 0, 0, (na - 0.25) / FPS, 'none', 0, order=1, jitter=False)
    sp.dynamic = layer
    self.add(sp)
