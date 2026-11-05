"""evidence_bubble (lane ch2, round 2): the narrator produces the evidence. His own typed message, as the chat bubble he
sent, pops in beside him while the narrator reads it out, and a real highlighter stroke runs across the words the narrator names.
Techniques: Vox's on-screen document with a hand-drawn highlight (a real artifact with the key words marked, not a
paraphrase); the chat-bubble "receipt" reveal used by explainer channels to show what someone actually typed; the iOS
message pop (scale from the tail with a small spring overshoot). Write-up: filmcraft/options-ch2/techniques/evidence-bubble.md.

Smooth UI element, so its moves carry motion blur (events/_ch2_motion.py); it sits still once it has landed
(synthetic-469527071d0e) and leaves sideways off the frame. Sounds: events/_ch2_sound.py.

    {"type": "evidence_bubble", "id": "note", "words": "line one\\nline two", "mark": "xantham gum",
     "right": x, "top": y, "at": s, "mark_at": s, "mark_s": 0.35, "out": s, "out_dir": "E", "size": 40}

`words` is his message exactly as he typed it (line breaks only added); `mark` is the run of those words the highlighter
covers. `right`/`top` place the bubble's top-right corner (1920x1080 frame)."""
import math
import random
from PIL import Image, ImageDraw, ImageFilter
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, compass, ease_in, ease_out
from overlay.helpers.motion_smear import smeared
from overlay.helpers.sound_classes import play

BUBBLE = (236, 236, 238)      # a light chat bubble, the colour of a sent message in a light-mode chat app
INK = (24, 24, 26)
HIGHLIGHT = (255, 221, 51)    # yellow: neutral meaning (the person's rules synthetic-43b5689d4046)


def _spring(u):
    """0 -> 1 with one small overshoot (critically under-damped), for the pop."""
    u = min(max(u, 0.0), 1.0)
    return 1 - math.exp(-6.5 * u) * math.cos(7.5 * u)


def _stroke_mask(w, h, seed):
    """A highlighter stroke w x h: chisel-cut ends, edges that wander a pixel or two, and a darker band where the two
    passes of a real marker overlap at each end."""
    rnd = random.Random(seed)
    m = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(m)
    top = [(x, 2 + rnd.uniform(-1.6, 1.6)) for x in range(6, w - 6, 9)]
    bot = [(x, h - 3 + rnd.uniform(-1.6, 1.6)) for x in range(w - 6, 6, -9)]
    d.polygon([(0, h * 0.18)] + top + [(w, 0), (w - 4, h)] + bot + [(4, h)], fill=150)
    for x0 in (0, w - 26):  # overlap of two passes at the ends
        d.rectangle([x0, 2, x0 + 26, h - 3], fill=205)
    return m.filter(ImageFilter.GaussianBlur(0.8))


def ev_evidence_bubble(self, e):
    sid = e.get('id', 'bubble')
    size = e.get('size', 40)
    fnt = kit.sf('text_medium', size)
    lines = e['words'].split('\n')
    asc, desc = fnt.getmetrics()
    lh = int((asc + desc) * 1.18)
    padx, pady, rad = 30, 20, 34
    tw = int(max(fnt.getlength(l) for l in lines))
    bw, bh = tw + 2 * padx, lh * len(lines) + 2 * pady
    tail = 18
    x0, y0 = e['right'] - bw, e['top']
    t_in, t_mark, t_out = self.T(e['at']), self.T(e['mark_at']), self.T(e['out'])
    mark_s = e.get('mark_s', 0.35)
    ox, oy = compass(e.get('out_dir', 'E'))

    base = Image.new('RGBA', (bw, bh + tail), (0, 0, 0, 0))
    d = ImageDraw.Draw(base)
    d.rounded_rectangle([0, 0, bw - 1, bh - 1], rad, fill=BUBBLE + (255,))
    d.polygon([(bw - 46, bh - 12), (bw - 2, bh + tail - 2), (bw - 18, bh - 30)], fill=BUBBLE + (255,))  # tail, bottom right
    text = Image.new('RGBA', base.size, (0, 0, 0, 0))
    dt = ImageDraw.Draw(text)
    for i, l in enumerate(lines):
        dt.text((padx, pady + i * lh), l, font=fnt, fill=INK + (255,))

    # where the marked words sit: the line holding them, from the first to the last letter, a little over-wide like a hand
    li = next(i for i, l in enumerate(lines) if e['mark'] in l)
    a = lines[li].index(e['mark'])
    mx0 = padx + fnt.getlength(lines[li][:a]) - 8
    mx1 = padx + fnt.getlength(lines[li][:a + len(e['mark'])]) + 8
    my0 = pady + li * lh + lh * 0.12
    my1 = pady + li * lh + lh * 0.92
    stroke = _stroke_mask(int(mx1 - mx0), int(my1 - my0), seed=sum(map(ord, sid)))
    self.safe_box(sid, x0, y0, x0 + bw, y0 + bh + tail, t_in, t_out)

    def leave(tt):
        if tt < t_out:
            return 0.0, 0.0
        u = ease_in((tt - t_out) / 0.42)
        return (None, None) if u >= 1 else (ox * u, oy * u)

    def frame_img(tt):
        im = base.copy()
        u = (tt - t_mark) / mark_s
        if u > 0:
            reveal = int(stroke.width * ease_out(min(u, 1.0)))
            if reveal > 2:
                m = Image.new('L', base.size, 0)
                m.paste(stroke.crop((0, 0, reveal, stroke.height)), (int(mx0), int(my0)))
                # multiply the yellow into the bubble, as ink on a light surface
                lay = Image.new('RGBA', base.size, tuple(int(b * h / 255) for b, h in zip(BUBBLE, HIGHLIGHT)) + (255,))
                im.paste(lay, (0, 0), m)
        im.alpha_composite(text)
        return im

    shadow_cfg = {'dx': 0, 'dy': 10, 'blur': 26, 'opacity': 0.38}

    def dyn(tt):
        dx, dy = leave(tt)
        if dx is None or tt < t_in:
            return None, 0, 0
        s = 0.55 + 0.45 * _spring((tt - t_in) / 0.42)
        im = frame_img(tt)
        if abs(s - 1) > 1e-3:
            im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.BICUBIC)
        a = min(1.0, (tt - t_in) / 0.12)
        if a < 1:
            im.putalpha(im.getchannel('A').point(lambda v: int(v * a)))
        img, p = stage.shadowed(im, shadow_cfg)
        # grows from its tail (bottom right), like a sent message
        gx = x0 + bw * (1 - s)
        gy = y0 + (bh + tail) * (1 - s)
        return img, gx - p + dx, gy - p + dy

    sp = SmoothSprite(self, sid, None, 0, 0, t_in, 'none', 0, order=70, jitter=False)
    sp.dynamic = smeared(dyn, leave)
    self.add(sp)
    play(self, 'ch2_in', t_in)
    play(self, 'ch2_slide', t_mark)
    play(self, 'ch2_out', t_out)
