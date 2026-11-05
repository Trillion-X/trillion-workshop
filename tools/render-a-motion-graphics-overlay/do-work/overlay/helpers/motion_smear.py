"""Helper for lane ch2's event files (not an event): motion blur along an element's own path for one frame, so a word or line
that leaves fast smears from where it was one frame ago to where it is now, as a real shutter would record it. Without it a
small glyph that moves farther than its own width per frame strobes (and film-qa's exit tracker cannot follow it)."""
import math
import numpy as np
import cv2
from PIL import Image

FRAME_S = 1001 / 24000


def smear(img, x, y, dx, dy, trail=0.52):
    """img placed at (x, y) that moved (dx, dy) px since the last frame -> (smeared img, x, y). Colour is the mean along a line
    kernel from the previous position to this one (a full-frame shutter); opacity is the larger of that mean and `trail`
    times the union of the path, so the streak stays one connected shape (a 2D animator's smear frame) instead of fading
    to nothing when the element moves farther than its own width."""
    L = math.hypot(dx, dy)
    if L < 3:
        return img, x, y
    n = int(math.ceil(L))
    pad = n + 2
    a = np.zeros((img.height + 2 * pad, img.width + 2 * pad, 4), np.float32)
    a[pad:pad + img.height, pad:pad + img.width] = np.asarray(img.convert('RGBA'), np.float32)
    a[..., :3] *= a[..., 3:4] / 255.0  # premultiplied, so the smear does not darken at the edges
    k = np.zeros((2 * n + 1, 2 * n + 1), np.float32)
    cv2.line(k, (n, n), (int(round(n + dx)), int(round(n + dy))), 1.0, 1)  # correlation: out(p) = mean of src(p + s*v)
    k /= k.sum()
    b = cv2.filter2D(a, -1, k, borderType=cv2.BORDER_CONSTANT)
    al = b[..., 3:4].copy()
    b[..., :3] = np.where(al > 0, b[..., :3] * 255.0 / np.maximum(al, 1e-3), 0)
    union = cv2.dilate(a[..., 3], (k > 0).astype(np.uint8))
    b[..., 3] = np.maximum(al[..., 0], trail * union)
    return Image.fromarray(np.clip(b, 0, 255).astype(np.uint8), 'RGBA'), x - pad, y - pad


def smeared(dyn, offset):
    """Wrap a sprite's dynamic(tt) -> (img, x, y) so that while its exit offset(tt) -> (dx, dy) (or (None, None) once it
    has left) is moving, each frame carries the smear of its travel over the last 1.5 frames: consecutive frames' smears
    overlap by a third or more, so the eye (and a shape tracker) reads one object moving, not separate flashes."""
    def wrapped(tt):
        img, x, y = dyn(tt)
        if img is None:
            return img, x, y
        d1, d0 = offset(tt), offset(tt - 1.5 * FRAME_S)
        if d1[0] is None or d0[0] is None:
            return img, x, y
        return smear(img, x, y, d1[0] - d0[0], d1[1] - d0[1])
    return wrapped
