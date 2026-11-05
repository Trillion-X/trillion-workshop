"""callout (lane ch2): annotation callout on a real object he holds (technique #240 annotation-callout, awesome-ai-motion;
filmcraft/options-ch2/techniques/annotation-callout.md). A dot sits on the object and follows it (track keyframes, linear between them),
a leader line grows from the dot to the label, the label rises in on its word. When the object turns away (detach) the
leader pulls back into the label and the dot goes with it; the label stays until `out`, then every label leaves together.

White SF Pro over footage with the soft wide shadow; drawn every frame (no stepping on footage).

    {"type": "callout", "id": "yeast", "label_size": 50, "out": s, "out_dir": "W",
     "labels": [{"text": "nutritional\\nyeast", "pos": [x, y], "at": s, "lead_s": 0.3, "detach": s,
                 "track": [[s, x, y], ...]}]}                 track times are seconds of the option clock like `at`
"""
from PIL import Image, ImageDraw
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, compass, ease_in, ease_out
from overlay.helpers.motion_smear import smeared


def _track(track, t):
    if t <= track[0][0]:
        return track[0][1], track[0][2]
    for (t0, x0, y0), (t1, x1, y1) in zip(track, track[1:]):
        if t <= t1:
            u = (t - t0) / max(t1 - t0, 1e-6)
            return x0 + (x1 - x0) * u, y0 + (y1 - y0) * u
    return track[-1][1], track[-1][2]


def ev_callout(self, e):
    sid = e.get('id', 'callout')
    fnt = kit.sf('display_semibold', e.get('label_size', 50))
    t_out = self.T(e['out'])
    ox, oy = compass(e.get('out_dir', 'W'))
    sh = look.LOOK['text_shadow']

    def leave(tt):
        if tt < t_out:
            return 0.0, 0.0
        u = ease_in((tt - t_out) / 0.45)
        return (None, None) if u >= 1 else (ox * u, oy * u)

    for k, lb in enumerate(e['labels']):
        im, pad = kit.text_img(lb['text'], fnt, kit.col('white'))
        lx, ly = lb['pos']
        w, h = im.width - 2 * pad, im.height - 2 * pad
        t_word = self.T(lb['at'])
        t_line = t_word - lb.get('lead_s', 0.3)
        t_det = self.T(lb['detach'])
        track = [(self.T(a), x, y) for a, x, y in lb['track']]
        attach = (lx + w + 14, ly + h * 0.5)
        self.safe_box(f'{sid}-label{k}', lx, ly, lx + w, ly + h, t_word, t_out)

        def label_dyn(tt, im=im, lx=lx, ly=ly, pad=pad, t_word=t_word):
            u = ease_out((tt - t_word) / 0.18)
            dx, dy = leave(tt)
            if dx is None:
                return None, 0, 0
            img = im
            if u < 1:
                img = im.copy()
                img.putalpha(im.getchannel('A').point(lambda v: int(v * u)))
            return img, lx - pad + dx, ly - pad + (1 - u) * 12 + dy

        sp = SmoothSprite(self, f'{sid}-label{k}', None, 0, 0, t_word, 'none', 0, order=62, jitter=False)
        sp.dynamic = smeared(label_dyn, leave)
        self.add(sp)

        def leader_dyn(tt, track=track, attach=attach, t_line=t_line, t_det=t_det):
            frac = ease_out((tt - t_line) / 0.3)
            fade = 1.0 - min(1.0, max(0.0, (tt - t_det) / 0.2))  # detach: the leader fades where it is (it does not fly off)
            if frac <= 0.01 or fade <= 0.0:
                return None, 0, 0
            dot = _track(track, min(tt, t_det))
            ex, ey = attach[0] + (dot[0] - attach[0]) * frac, attach[1] + (dot[1] - attach[1]) * frac
            x0, y0 = min(attach[0], ex) - 20, min(attach[1], ey) - 20
            layer = Image.new('RGBA', (int(abs(ex - attach[0]) + 40), int(abs(ey - attach[1]) + 40)), (0, 0, 0, 0))
            d = ImageDraw.Draw(layer)
            col = (255, 255, 255, int(255 * fade))
            d.line([(attach[0] - x0, attach[1] - y0), (ex - x0, ey - y0)], fill=col, width=4)
            r = 9 * min(1.0, frac * 1.5)
            d.ellipse([ex - x0 - r, ey - y0 - r, ex - x0 + r, ey - y0 + r], fill=col)
            img, p = stage.shadowed(layer, sh)
            return img, x0 - p, y0 - p

        ls = SmoothSprite(self, f'{sid}-leader{k}', None, 0, 0, t_line, 'none', 0, order=61, jitter=False)
        ls.dynamic = leader_dyn
        self.add(ls)
        self.sound('tick', t_line)
        self.sound('word_in', t_word)
    self.sound('slide_out', t_out)
