"""The `pile` event. Ported from narrator/tools/render_correction.py:616."""
import cv2
import numpy as np
from PIL import Image

from overlay import stage


def ev_pile(self, e):
    c = self.shot['cutout']
    x0, y0, x1, y1 = e['source_box']
    im = cv2.cvtColor(cv2.imread(stage.P(c['image'])), cv2.COLOR_BGR2RGB)[y0:y1, x0:x1]
    hsv = cv2.cvtColor(im, cv2.COLOR_RGB2HSV)
    flesh = (((hsv[..., 0] <= 11) | (hsv[..., 0] >= 170)) & (hsv[..., 1] >= 120) & (hsv[..., 2] > 150)).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(flesh)
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    hull = cv2.convexHull(np.argwhere(lab == big)[:, ::-1].astype(np.int32))
    m = np.zeros(flesh.shape, np.uint8)
    cv2.fillConvexPoly(m, hull, 255)
    rind = int(20 * stage.K) | 1
    m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (rind, rind)))
    m[hsv[..., 2] < 120] = 0
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    ys, xs = np.where(m > 20)
    im, m = im[ys.min():ys.max() + 1, xs.min():xs.max() + 1], m[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    slice_img = self.sticker(np.ascontiguousarray(im), np.ascontiguousarray(m), seed=31)
    sw = int(e['w'] * stage.K)
    slice_img = slice_img.resize((sw, int(slice_img.height * sw / slice_img.width)), Image.LANCZOS)
    rng = np.random.default_rng(e.get('seed', 1))
    t0, t1 = self.T(e['at']), self.T(e['until'])
    ax0, ay0, ax1, ay1 = [v * stage.K for v in e['area']]
    for i in range(e['count']):
        frac = i / max(1, e['count'] - 1)
        img = slice_img.rotate(rng.uniform(-35, 35), expand=True, resample=Image.BICUBIC)
        img, pad = stage.shadowed(img, {'dx': 3, 'dy': 6, 'blur': 8, 'opacity': 0.4})
        x = ax0 + rng.uniform(0, ax1 - ax0 - img.width)
        y = ay1 - img.height - (ay1 - ay0 - img.height) * frac * rng.uniform(0.6, 1.0)
        tt = t0 + (t1 - t0) * frac
        self.add(stage.Sprite(e.get('id', 'pile'), img, x, y, tt, 'pop', 0.12, order=45 + i * 0.01))
        self.sound(['pop', 'pop2', 'pop3'][i % 3], tt)
