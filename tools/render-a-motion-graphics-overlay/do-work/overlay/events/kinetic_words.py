"""kinetic_words (lane ch1 cold opens, round 8): a question or line in white SF Pro that builds word by word over footage, each
word rising a little as it fades in, and leaves the same way, word by word. Device: the stake in kinetic type before hello
(library/DEVICES.md, Hooks). White SF Pro Display/Text with the soft wide shadow over footage (look_r2 text_shadow), motion blur on
every move in and out (events/_ch2_motion.smear: a word that moves farther than a few px a frame is smeared along its path),
inside the title-safe area (safe_box). Words are not paper, so no stop-motion and no jitter.

    {"type": "kinetic_words", "id": "q", "text": "Can the food you love\\nalso be the food your body needs?",
     "font": "display_bold", "size": 104, "heavy": ["love", "needs?"], "heavy_font": "display_heavy",
     "pos": [96, 640], "align": "left", "times": [s, s, ...] (one per word, seconds from the overlay's first frame),
     "out": s, "out_stagger_s": 0.05, "out_px": 46 (0 = the words fade out in place, no moving exit), "sound": "ch2_tick" (per word; omit for none), "out_sound": "ch2_out"}

`ready_at` (s): the whole text arrives together at that time (synthetic-9710181698cd: a card's text is complete when the card appears), and `times`
then only cue the words, each word getting its `sound`; `lit` {"dim": 0.55, "times": [s or null per word]} dims a word to that alpha from the
start until its time, when it lights to full (null = never dimmed): the motion is emphasis on text that is already there, not the reveal.
With "mode": "colour" the dim is the word's ink (white towards grey) instead of its opacity, so the block's footprint does not change as it lights: over
a soft_backing the two look alike, and film-qa settle (which reads alpha mass) sees a block that sits still instead of an ease that drags.

`pos` is the block's top-left; with "center": [cx, cy] instead the block is centred on that point (lines centred on each other); with
"right": x and "top": y the block's right edge is at x and its lines are right-aligned (a block in a lower corner).
"""
from PIL import Image
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, ease_in, ease_out
from overlay.helpers.motion_smear import FRAME_S, smear
from overlay.helpers.sound_classes import play

RISE_PX = 34       # a word starts this far below its place and rises into it
IN_S = 0.24        # seconds a word takes to arrive
OUT_PX = 46        # a word leaves this far upward
OUT_S = 0.30


def ev_kinetic_words(self, e):
    sid = e.get('id', 'kinetic')
    f_main = kit.sf(e.get('font', 'display_bold'), e['size'])
    f_heavy = kit.sf(e.get('heavy_font', 'display_heavy'), e['size'])
    heavy = set(e.get('heavy', []))
    white = kit.col(e.get('colour', 'white'))
    lines = [l.split() for l in e['text'].split('\n')]
    words = [w for l in lines for w in l]
    times = [self.T(t) for t in e['times']]
    ready = self.T(e['ready_at']) if e.get('ready_at') is not None else None
    lit = [None if t is None else self.T(t) for t in e['lit']['times']] if e.get('lit') else None
    if len(times) != len(words):
        raise SystemExit(f'{self.id}: {sid} has {len(words)} words and {len(times)} times')
    t_out = self.T(e['out'])
    stag = e.get('out_stagger_s', 0.05)
    asc, desc = f_main.getmetrics()
    lh = int((asc + desc) * e.get('leading', 1.12))
    gap = f_main.getlength(' ')

    # layout: each word's top-left inside the block, then the block's place on the frame
    pieces, k = [], 0   # (image, pad, x in block, y in block)
    widths = []
    for l in lines:
        ws = [f_heavy.getlength(w) if w in heavy else f_main.getlength(w) for w in l]
        widths.append(sum(ws) + gap * (len(l) - 1))
    bw, bh = int(max(widths)), lh * len(lines)
    align = e.get('align', 'left')
    if e.get('center'):
        x0, y0 = e['center'][0] - bw / 2, e['center'][1] - bh / 2
    elif e.get('right') is not None:
        x0, y0, align = e['right'] - bw, e['top'], 'right'
    else:
        x0, y0 = e['pos']
    for li, l in enumerate(lines):
        x = {'left': 0, 'center': (bw - widths[li]) / 2, 'right': bw - widths[li]}[align]
        for w in l:
            fnt = f_heavy if w in heavy else f_main
            im, pad = kit.text_img(w, fnt, white, shadow=True)
            pieces.append((im, pad, x, li * lh))
            x += fnt.getlength(w) + gap
            k += 1
    start = ready if ready is not None else times[0]
    self.safe_box(sid, x0, y0, x0 + bw, y0 + bh, start, t_out + OUT_S + stag * len(words))
    PAD = 90   # room for the shadow and the smear around the block
    cw, ch = bw + 2 * PAD, bh + 2 * PAD + RISE_PX + OUT_PX

    ink_dim = bool(lit) and e['lit'].get('mode', 'alpha') == 'colour'

    def word_state(i, tt):
        """(alpha, dy, ink) of word i at tt: rises in from below, later leaves upward; ink is the share of full white (the colour-mode dim); None before it starts."""
        t_in = ready if ready is not None else times[i]
        if tt < t_in:
            return None
        u = ease_out((tt - t_in) / IN_S)
        dy = (1 - u) * e.get('rise_px', RISE_PX)
        a, ink = u, 1.0
        if lit is not None and lit[i] is not None:
            k = e['lit']['dim'] + (1 - e['lit']['dim']) * ease_out((tt - lit[i]) / IN_S)
            if ink_dim:
                ink = round(k, 2)
            else:
                a *= k
        v = (tt - (t_out + i * stag)) / OUT_S
        if v > 0:
            if v >= 1:
                return None
            v = ease_in(v)
            dy -= e.get('out_px', OUT_PX) * v
            a *= 1 - v
        return a, dy, ink

    inked = {}

    def ink_img(i, im, ink):
        """word i's image with its colour scaled to ink (alpha kept)"""
        if ink >= 1.0:
            return im
        if (i, ink) not in inked:
            r, g, b, al = im.split()
            inked[(i, ink)] = Image.merge('RGBA', [c.point(lambda v, k=ink: int(v * k)) for c in (r, g, b)] + [al])
        return inked[(i, ink)]

    def block(tt):
        canvas = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
        any_word = False
        for i, (im, pad, px, py) in enumerate(pieces):
            st = word_state(i, tt)
            if st is None:
                continue
            any_word = True
            a, dy, ink = st
            prev = word_state(i, tt - 1.5 * FRAME_S)
            w = ink_img(i, im, ink)
            if a < 1:
                w = w.copy()
                w.putalpha(im.getchannel('A').point(lambda v, a=a: int(v * a)))
            x, y = PAD + px - pad, PAD + RISE_PX + py - pad + dy
            # a word's first frame came from below its place, not from nowhere: its previous place is where it starts
            w, x, y = smear(w, x, y, 0.0, dy - (prev[1] if prev else e.get('rise_px', RISE_PX)))
            canvas.alpha_composite(w, (int(round(x)), int(round(y))))
        return canvas if any_word else None

    def dyn(tt):
        c = block(tt)
        if c is None:
            return None, 0, 0
        return c, x0 - PAD, y0 - PAD - RISE_PX
    s = SmoothSprite(self, sid, None, 0, 0, start, 'none', 0, order=e.get('order', 72), jitter=False)
    s.dynamic = dyn
    self.add(s)
    if e.get('sound'):
        for t in (times if ready is None else [ready]):
            play(self, e['sound'], t)
    if e.get('out_sound'):
        play(self, e['out_sound'], t_out)
