"""The `ctick` event. Ported from filmcraft/options-ch1/tools-round-2/r2.py:477."""
import numpy as np
from PIL import Image, ImageDraw

from overlay import stage


def ev_ctick(self, e):
    s = e.get('size', 64)
    pad = 10
    m = Image.new('L', (s + 2 * pad, s + 2 * pad), 0)
    rng = np.random.default_rng(e.get('seed', 3))
    pts = [(pad + s * 0.02, pad + s * 0.52), (pad + s * 0.36, pad + s * 0.86), (pad + s * 0.98, pad + s * 0.08)]
    jit = lambda p: (p[0] + rng.normal(0, 1.2), p[1] + rng.normal(0, 1.2))
    ImageDraw.Draw(m).line([jit(p) for p in pts], fill=255, width=int(s * 0.3), joint='curve')
    import cv2
    a = np.asarray(m).astype(np.float32)
    noise = cv2.GaussianBlur(rng.uniform(0, 1, a.shape).astype(np.float32), (0, 0), 1.5)
    a = ((a / 255.0 + (noise - 0.5) * 0.5) > 0.5).astype(np.uint8) * 255
    photo = Image.open(e['photo']).convert('RGB') if e.get('photo') else None
    piece = self.collage_piece(Image.fromarray(a), e['paper'], e.get('seed', 3), photo)
    piece = piece.rotate(e.get('rot', 0), expand=True, resample=Image.BICUBIC)
    t = self.T(e['at'])
    sp = stage.Sprite(e.get('id', 'ctick'), piece, e['pos'][0] - 10, e['pos'][1] - 10, t, 'pop', 0.17, order=76, jitter=True)
    self.add(sp)
    self.sound(e.get('sound', 'piece1'), t)
