"""The `cutout` event: the speaker cut out of a real frame as a sticker (coloured-pencil restyle, cream outline, drop shadow)
that pops in and moves as the spec says. `run_off_bottom` (px) sets the last move's dy so that, after every move's scale, the
lowest opaque row of the figure lands that many px below the frame edge: the frame edge cuts the figure, and no paper or
bare straight edge shows under it. Ported from narrator/tools/render_correction.py:280 and r3.py:479."""
import cv2
import numpy as np

from overlay import look, stage


def ev_cutout(self, e):
    c = self.shot['cutout']
    im = cv2.cvtColor(cv2.imread(stage.P(c['image'])), cv2.COLOR_BGR2RGB)
    m = cv2.imread(stage.P(c['mask']), cv2.IMREAD_GRAYSCALE)
    ys, xs = np.where(m > 20)
    pad = int(look.R['cutout']['outline_px'] * stage.K * 2)
    x0, y0 = max(xs.min() - pad, 0), max(ys.min() - pad, 0)
    x1, y1 = min(xs.max() + pad, stage.W), min(ys.max() + pad, stage.H)
    img = self.sticker(im[y0:y1, x0:x1], m[y0:y1, x0:x1], seed=7)
    img, spad = stage.shadowed(img, look.R['cutout']['shadow'])
    t = self.T(e['at'])
    sp = self.add(stage.Sprite(e.get('id', 'cutout'), img, x0 - spad, y0 - spad, t, 'pop', look.R['cutout']['pop_s'], order=40))
    for mv in e.get('moves', []):
        sp.moves.append({'t': self.T(mv['at']), 'dur': mv['dur'], 'dx': mv.get('dx', 0), 'dy': mv.get('dy', 0), 'scale': mv.get('scale', 1)})
    self.sound('pop', t)
    if e.get('run_off_bottom') is None:
        return
    a = np.asarray(sp.img)[..., 3]
    fig_bottom = np.where((a > 200).any(1))[0][-1] + 1  # rows below this are only the drop shadow
    h, scale, dy = sp.img.height, 1.0, 0.0
    for m in sp.moves:
        scale *= m['scale']
        dy += m['dy'] * stage.K
    bottom = sp.y + dy + h / 2 + (fig_bottom - h / 2) * scale
    shift = stage.H + e['run_off_bottom'] - bottom
    sp.moves[-1]['dy'] += shift / stage.K
    print(f"{self.id}: cut-out moved {shift:+.1f} px so the figure runs {e['run_off_bottom']} px off the bottom edge")
