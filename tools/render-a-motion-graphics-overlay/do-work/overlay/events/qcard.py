"""The `qcard` event. Ported from filmcraft/options-ch1/tools-round-2/r2.py:208."""
from PIL import Image, ImageDraw

from overlay import look, stage


def ev_qcard(self, e):
    """Typewriter question on torn paper. Slides in from the right on e.at; the words of `then` type on at their
    spoken times; leaves on e.out by sliding right (exit 'slide') or crumpling into a ball that drops (exit 'crumple')."""
    self.seed += 1
    seed = self.seed
    size = e['size']
    full = e['text'] + ('\n' + e['then']['text'] if e.get('then') else '')
    base = self.paper_text_img(full, size, 'crumpled', seed)
    # blank the `then` lines so they can type on: re-draw the card with only the first block and keep geometry
    fnt = stage.font(look.R['fonts']['typewriter'], size)
    lh = fnt.getbbox('Hg')[3] * 1.15
    padp = look.R['scrap']['pad_px']
    n_first = len(e['text'].split('\n'))
    then_words = e['then']['text'].split(' ') if e.get('then') else []
    then_times = [self.T(x) for x in e['then']['times']] if e.get('then') else []
    blank = self.paper_text_img(full.replace(e['then']['text'], '') if e.get('then') else full, size, 'crumpled', seed)
    rot = e.get('rot', 0)
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    sl = look.LOOK['slide']
    x_end, y_end = e['pos']
    cache = {}

    def face(k):
        if k not in cache:
            if not then_words or k >= len(then_words):
                im = base.copy() if then_words else base
            else:
                im = blank.copy()
                if k > 0:
                    d = ImageDraw.Draw(im)
                    d.text((padp, padp * 0.8 + n_first * lh), ' '.join(then_words[:k]), font=fnt, fill=stage.rgb('ink') + (255,))
            im = im.rotate(-rot, expand=True, resample=Image.BICUBIC)
            im, pad = stage.shadowed(im, look.R['card']['shadow'])
            cache[k] = (im, pad)
        return cache[k]

    ball = None
    if e.get('exit') == 'crumple':
        ball = self.paper_ball(int(base.height * 0.55), seed)

    def dyn(tt):
        k = sum(1 for x in then_times if x <= tt)
        im, pad = face(k)
        x, y = x_end - pad, y_end - pad
        if tt < t_in + sl['in_s']:
            u = stage.ease_out((tt - t_in) / sl['in_s'])
            x += (1 - u) * (stage.W - x_end + 60)
        if tt >= t_out:
            if e.get('exit') == 'crumple':
                u = (tt - t_out) / 0.32
                cx, cy = x + im.width / 2, y + im.height / 2
                if u < 1:
                    s = 1 - 0.7 * stage.ease_in(u)
                    sq = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s * (1 - 0.25 * u)))), Image.BILINEAR)
                    sq = sq.rotate(u * 25, expand=True, resample=Image.BICUBIC)
                    b = ball.copy()
                    b.putalpha(b.getchannel('A').point(lambda v: int(v * min(1, u * 1.6))))
                    out = Image.new('RGBA', (max(sq.width, b.width), max(sq.height, b.height)), (0, 0, 0, 0))
                    a2 = sq.copy()
                    a2.putalpha(a2.getchannel('A').point(lambda v: int(v * (1 - u))))
                    out.alpha_composite(a2, ((out.width - sq.width) // 2, (out.height - sq.height) // 2))
                    out.alpha_composite(b, ((out.width - b.width) // 2, (out.height - b.height) // 2))
                    return out, cx - out.width / 2, cy - out.height / 2
                v = (tt - t_out - 0.32)
                fall = 0.5 * 4200 * v * v
                b = ball.rotate(-v * 400, expand=True, resample=Image.BICUBIC)
                if cy + fall - b.height > stage.H:
                    return None, 0, 0
                return b, cx - b.width / 2 + v * 80, cy - b.height / 2 + fall
            u = stage.ease_in((tt - t_out) / sl['out_s'])
            if u >= 1:
                return None, 0, 0
            x += u * (stage.W - x_end + 80)
        return im, x, y
    sp = stage.Sprite(e.get('id', 'qcard'), None, 0, 0, t_in, 'none', 0, order=50, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('slide_in', t_in)
    for x in then_times[::2]:
        self.sound('key', x)
    if e.get('exit') == 'crumple':
        self.sound('crumple', t_out)
        self.sound('fall', t_out + 0.3)
    else:
        self.sound('slide_out', t_out)
