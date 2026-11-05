"""word-stack-drop: each thing he names drops in from above the frame as a white SF Pro word and lands on the pile beside him
(ease-out with a small settle, a real pop on landing), so the list builds into a stack you can read at a glance. A word he
rules out is flicked off the pile sideways on the word that rules it out, and the pile closes up; at the end the whole pile
drops out of the bottom of the frame.

Spec: {type: wordstack, id, x, base_y, size, gap, at, out, words: [{text, at}], remove: {word, at, dir: -1|1}}"""
import math
from overlay import kit, stage
from overlay.helpers import marker_and_slide as L

FALL_S = 0.38


def ev_wordstack(self, e):
    fnt = kit.sf(e.get('font', 'display_bold'), e['size'])
    words = e['words']
    imgs = [kit.text_img(w['text'], fnt, L.col('white'), shadow=True) for w in words]
    lh = int(e['size'] * e.get('gap', 1.22))
    times = [self.T(w['at']) for w in words]
    t_out = self.T(e['out'])
    rm = e.get('remove')
    rm_i = rm['word'] if rm else None
    rm_t = self.T(rm['at']) if rm else None
    x, base = e['x'], e['base_y']

    def slot(i, tt):
        """Height index of word i at time tt: words below it, less the removed one once it has gone (closing over 0.3 s)."""
        k = float(i)
        if rm and i > rm_i and tt >= rm_t:
            k -= L.ease_in_out((tt - rm_t - 0.15) / 0.3, 2.0) if tt >= rm_t + 0.15 else 0.0
        return k
    top = base - lh * (len(words) - 1)
    for i, ((im, pad), t) in enumerate(zip(imgs, times)):
        self.safe_box(f"{e.get('id', 'stack')}-{i}", x, top, x + im.width - 2 * pad, base + lh, t, t_out)

        def dyn(tt, im=im, pad=pad, t=t, i=i):
            y_rest = base - lh * slot(i, tt)
            u = min(1.0, (tt - t) / FALL_S)
            y = y_rest - (1 - L.ease_out(u)) * (y_rest + lh + 40)
            if u >= 1 and tt < t + FALL_S + 0.16:  # a small settle after landing
                y -= 6 * math.sin(math.pi * (tt - t - FALL_S) / 0.16)
            xx = x
            if rm and i == rm_i and tt >= rm_t:
                v = L.ease_in((tt - rm_t) / 0.32)
                if v >= 1:
                    return None, 0, 0
                xx += rm.get('dir', 1) * v * (stage.W + 200)
            if tt >= t_out:
                v = L.ease_in((tt - t_out - 0.04 * i) / 0.45) if tt >= t_out + 0.04 * i else 0.0
                y += v * (stage.H + 200)
                if v >= 1:
                    return None, 0, 0
            return im, xx - pad, y - pad
        sp = stage.Sprite(f"{e.get('id', 'stack')}-{i}", None, 0, 0, t, 'none', 0, order=60, jitter=False)
        sp.dynamic = dyn
        self.add(sp)
        self.sound(['pop', 'pop2', 'pop3'][i % 3], t + FALL_S - 0.03)
    if rm:
        self.sound('word_out', rm_t)
    self.sound('card_out', t_out)
