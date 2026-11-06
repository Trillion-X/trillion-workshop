"""split-compare: two of his own clips side by side filling the frame, a then-and-now pair. Each panel slides in from its own
edge on its word and plays every frame (no stop-motion on footage); a panel can drain to grey on the word that judges it
(colour drain, the classic before/after grade). Each panel's label is ink on a small kraft tag near its top, so it reads on a
bright plate as well as a dark pan (synthetic-6f427677987b). Both panels slide back out to their edges together, uncovering the A-roll.

Spec: {type: split, id, at, out, panels: [{side: left|right, src: {video, start, dur, loop, focus} | {image, focus}, at,
       drain_at, label, label_at}], gutter, label_px}
(at: when the first panel arrives; film-qa reads it with covers_a_roll for the time the A-roll is hidden. Both panels should
arrive together so the frame is never half covered over his face; each label lands on its own word.)"""
import numpy as np
from PIL import Image, ImageDraw
from overlay import kit, stage
from overlay.helpers import marker_and_slide as L


def ev_split(self, e):
    g = e.get('gutter', 10)
    pw = (stage.W - g) // 2
    t_out = self.T(e['out'])
    fl = L.face('Kalam-Bold.ttf', e.get('label_px', 40))
    for k, p in enumerate(e['panels']):
        left = p['side'] == 'left'
        x_end = 0 if left else stage.W - pw
        t_in = self.T(p['at'])
        drain_t = self.T(p['drain_at']) if p.get('drain_at') is not None else None
        lab_t = self.T(p.get('label_at', p['at']))
        src = p['src']
        if 'image' in src:
            still = kit.cover(Image.open(src['image']).convert('RGB'), pw, stage.H, tuple(src.get('focus', (0.5, 0.5))))
            reader, n_src = None, 0
        else:
            still = None
            reader = kit.ClipReader(src['video'], src['start'], (pw, stage.H), speed=src.get('speed', 1.0))
            n_src = int(src['dur'] * stage.FPS)
        lab = None
        if p.get('label'):
            self.seed += 1
            tw, th = int(fl.getlength(p['label'])) + 44, int(fl.size * 1.6)
            tag = L.paper(tw, th, 'kraft', self.seed, edge_amp=3, step=7)
            ImageDraw.Draw(tag).text((tw / 2, th / 2), p['label'], font=fl, fill=L.col('ink') + (255,), anchor='mm')
            lab = L.shadow(tag.rotate(-1.5 if left else 1.5, expand=True, resample=Image.BICUBIC))

        def dyn(tt, left=left, x_end=x_end, t_in=t_in, drain_t=drain_t, reader=reader, still=still,
                n_src=n_src, lab=lab, src=src, lab_t=lab_t):
            if reader is not None:
                i = int(max(0.0, self.t_exact - t_in) * stage.FPS)
                i = i % n_src if src.get('loop') else min(i, n_src - 1)
                fr = reader.get(i)
            else:
                fr = still
            if drain_t is not None and tt >= drain_t:
                u = min(1.0, L.ease_in_out((tt - drain_t) / 1.1, 1.5))
                a = np.asarray(fr).astype(np.float32)
                grey = a @ np.array([0.2126, 0.7152, 0.0722], np.float32)
                a = a * (1 - u) + (grey[..., None] * 0.92 + 8) * u
                fr = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
            im = fr.convert('RGBA')
            if lab is not None and tt >= lab_t:
                li, lp = lab
                im.alpha_composite(li, (int((pw - li.width) / 2), int(stage.H * 0.08)))
            x = x_end
            off = -pw - 20 if left else pw + 20
            if tt < t_in + 0.42:
                x += (1 - L.ease_out((tt - t_in) / 0.42)) * off
            if tt >= t_out:
                v = L.ease_in((tt - t_out) / 0.4)
                if v >= 1:
                    return None, 0, 0
                x += v * off
            return im, x, 0
        sp = kit.SmoothSprite(self, f"{e.get('id', 'split')}-{k}", None, 0, 0, t_in, 'none', 0, order=2, jitter=False)
        sp.dynamic = dyn
        self.add(sp)
        if t_in not in [t for k_, t in self.sounds if k_ == 'card_in']:  # panels that arrive together make one sound
            self.sound('card_in', t_in)
        if lab is not None:
            self.sound('drop', lab_t)
    self.sound('card_out', t_out)
