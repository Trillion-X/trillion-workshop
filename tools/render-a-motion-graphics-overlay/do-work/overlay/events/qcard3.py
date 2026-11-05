"""The `qcard3` event. Ported from filmcraft/options-ch1/tools-round-3/r3.py:283."""
from PIL import Image

from overlay import kit, look, stage


# ---------- question card: whole question from the first frame; slide out or real crumple ----------
def ev_qcard3(self, e):
    self.seed += 1
    seed = self.seed
    flat = self.paper_text_img(e['text'], e['size'], 'crumpled', seed)
    rot = e.get('rot', 0)
    shown = flat.rotate(-rot, expand=True, resample=Image.BICUBIC)
    img, pad = stage.shadowed(shown, look.R['card']['shadow'])
    x_end = stage.W - kit.SAFE - e.get('right_gap', 24) - shown.width - pad  # opaque card right edge sits inside the safe area
    y_end = e['y'] - pad
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    self.safe_box(e.get('id', 'qcard'), *self.opaque_box(img, x_end, y_end), t_in, t_out)
    sl = look.LOOK['slide']
    crumple = None
    if e.get('exit') == 'crumple':
        crumple = self.crumple_frames(flat, rot, e.get('crumple_seed', 3), e.get('crumple_s', 0.55))
    cx = x_end + img.width / 2
    cy = y_end + img.height / 2
    fall = look.LOOK3['fall']

    def dyn(tt):
        x, y = x_end, y_end
        if tt < t_in + sl['in_s']:
            x += (1 - stage.ease_out((tt - t_in) / sl['in_s'])) * (stage.W - x_end + 60)
        if tt >= t_out:
            if crumple is None:
                u = stage.ease_in((tt - t_out) / sl['out_s'])
                if u >= 1:
                    return None, 0, 0
                return img, x + u * (stage.W - x_end + 80), y
            frames, meta = crumple
            k = int((tt - t_out) * meta['fps'])
            if k < len(frames):  # the card itself folding into a ball (Blender cloth on the card image)
                fr, fpad = frames[k]
                return fr, cx - fr.width / 2, cy - fr.height / 2
            fr, fpad = frames[-1]
            v = tt - t_out - len(frames) / meta['fps']
            ball = fr.rotate(-v * fall['spin_deg_s'], expand=True, resample=Image.BICUBIC)
            dy = 0.5 * fall['gravity_px_s2'] * v * v
            if cy + dy - ball.height / 2 > stage.H:
                return None, 0, 0
            return ball, cx - ball.width / 2 + v * fall['drift_px_s'], cy - ball.height / 2 + dy
        return img, x, y
    sp = stage.Sprite(e.get('id', 'qcard'), None, 0, 0, t_in, 'none', 0, order=50, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('slide_in', t_in)
    if crumple is None:
        self.sound('slide_out', t_out)
    else:
        self.sound('crumple', t_out)
        self.sound('fall', t_out + len(crumple[0]) / crumple[1]['fps'])
