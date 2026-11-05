"""The `ctick3` event. Ported from filmcraft/options-ch1/tools-round-3/r3.py:453."""
import numpy as np
from PIL import Image, ImageDraw

from overlay import stage


# ---------- ticks: one treatment for every tick ----------
def ev_ctick3(self, e):
    s = e.get('size', 84)
    pad = 10
    m = Image.new('L', (s + 2 * pad, s + 2 * pad), 0)
    rng = np.random.default_rng(e.get('seed', 3))
    pts = [(pad + s * 0.02, pad + s * 0.52), (pad + s * 0.36, pad + s * 0.86), (pad + s * 0.98, pad + s * 0.08)]
    jit = lambda p: (p[0] + rng.normal(0, 1.2), p[1] + rng.normal(0, 1.2))
    ImageDraw.Draw(m).line([jit(p) for p in pts], fill=255, width=int(s * e.get('stroke', 0.3)), joint='curve')
    import cv2
    a = np.asarray(m).astype(np.float32)
    noise = cv2.GaussianBlur(rng.uniform(0, 1, a.shape).astype(np.float32), (0, 0), 1.5)
    a = ((a / 255.0 + (noise - 0.5) * 0.5) > 0.5).astype(np.uint8) * 255
    photo = Image.open(e['photo']).convert('RGB') if e.get('photo') else None
    piece = self.collage_piece(Image.fromarray(a), 'photo' if photo else e['paper'], e.get('seed', 3), photo)
    piece = piece.rotate(e.get('rot', 0), expand=True, resample=Image.BICUBIC)
    t = self.T(e['at'])
    x, y = e['pos'][0] - 10, e['pos'][1] - 10
    self.safe_box(e.get('id', 'ctick'), *self.opaque_box(piece, x, y), t)
    if e.get('avoid'):  # never over a letter: the tick's opaque box must end left of the card's first letter
        ox = self.opaque_box(piece, x, y)[2]
        if ox > e['avoid']:
            raise SystemExit(f'{self.id}: tick {e.get("id")} reaches x={ox:.0f}, over the first letter at x={e["avoid"]:.0f}')
    sp = self.add(stage.Sprite(e.get('id', 'ctick'), piece, x, y, t, 'pop', 0.17, order=76, jitter=bool(e.get('jitter_s'))))
    self.paper_motion(sp, e, t)
    self.sound(e.get('sound', 'piece1'), t)
