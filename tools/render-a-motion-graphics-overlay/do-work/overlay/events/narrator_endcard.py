"""narrator_endcard (lane ch5, round 2): the film's last word goes to the narrator, and it is plain that it is the narrator talking. His own
label (the kraft strip and typewriter face of "narrated by Sam", chapter 1's narrator tag and chapter 2's narrator_label) slaps
onto the held last frame with a live voice meter in it: ink bars that move with his voice and lie flat when he stops (the
podcast audiogram, Headliner / Descript style, so a voice with no face still has a body on screen). Beside it his file card
on the experiment, in his typewriter face, filled in as he says it: version 2 with "soy milk" typed and struck through in red
marker on "without the soy milk" (strikethrough-replace), version 1 as a real photo from the film clipped to the card with an
"ICY" rubber stamp thumped on it on "icy" (the running record: the narrator keeps the channel's memory), then the question in
large type and two ballot boxes (a tick, a cross) for the comments. The question stays to the film's last frame (synthetic-773498f4ebe6): the card
only leaves after the preview has ended (its `out` is past the export's end), so on screen it never moves out of the way.

    {"type": "narrator_endcard", "id": "end", "pos": [x, y], "w": 680, "at": s, "out": s, "exit": "right",
     "tag": {"words": "narrated by Sam", "at": s, "size": 30, "voice": {"file": wav, "start_s": s}},
     "v2": {"label": "Version 2", "at": s, "struck": {"text": "soy milk", "at": s}},
     "v1": {"label": "Version 1", "at": s, "photo": path, "crop": [x0, y0, x1, y1], "stamp": {"text": "ICY", "at": s}},
     "ask": {"text": "Would you try\\nthis made-up dish?", "at": s, "size": 46},
     "reply": {"text": "Tell him in the comments", "at": s, "size": 30}}

The card is paper, so it slides in and out with motion blur on the slide (a camera-world move) and sits perfectly still
while it is up (synthetic-469527071d0e); the parts inside it land with small eases. Sounds: the swipe in (card_in), a fingertip
landing on a book for the tag, one real key press as each typed part lands (two different keys in turn, never a loop), the
marker for the strike, a paper thump for the stamp, a metal clip for the photo, the swish out (card_out) after the film's end."""
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw
from overlay import look, stage
from overlay.kit import SmoothSprite

from overlay.helpers import paper_pieces as K
from overlay.helpers import slide_pieces as C

TWOS = 2 * 1001 / 24000
STAMP_BLUE = (38, 74, 160)


def typewriter(size):
    return stage.font(look.R['fonts']['typewriter'], size)


def voice_meter(path, start_s, fps=24000 / 1001):
    """Per overlay frame: the voice's loudness 0..1 (RMS over the frame, -40..-8 dBFS mapped to 0..1)."""
    raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', '24000', '-'],
                         capture_output=True, check=True).stdout
    y = np.frombuffer(raw, np.float32)
    hop = 1001  # 24000 / fps samples per frame
    n = len(y) // hop
    rms = np.sqrt(np.mean(y[:n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    lv = np.clip((db + 40) / 32, 0, 1)
    pad = int(round(start_s * fps))
    return np.concatenate([np.zeros(pad), lv])


def ev_narrator_endcard(self, e):
    sid = e.get('id', 'endcard')
    T = self.T
    W = e.get('w', 680)
    tag, v1, v2, ask, reply = e['tag'], e['v1'], e['v2'], e['ask'], e['reply']
    t_in, t_out = T(e['at']), T(e['out'])
    x, y = e['pos']

    # ---------------------------------------------------------------- the tag with his live voice meter (paper: on twos, no blur)
    tsz = tag.get('size', 30)
    tf = typewriter(tsz)
    tw = int(tf.getlength(tag['words']))
    bars, bar_w, bar_gap = 9, 6, 5
    meter_w = bars * (bar_w + bar_gap)
    th = int(tsz * 1.9)
    twid = tw + meter_w + 3 * tsz
    base_tag = Image.new('RGBA', (twid, th), (0, 0, 0, 0))
    d = ImageDraw.Draw(base_tag)
    d.polygon(stage.torn_polygon(twid, th, 4, 5, step=7), fill=stage.rgb('kraft') + (238,))
    d.text((tsz, th / 2), tag['words'], font=tf, fill=stage.rgb('ink') + (255,), anchor='lm')
    base_tag = stage.apply_texture(base_tag, 'kraft', 5)
    level = voice_meter(tag['voice']['file'], tag['voice']['start_s'])
    shape = np.array([0.45, 0.75, 1.0, 0.8, 0.55, 0.9, 0.65, 0.4, 0.7])  # each bar's share of the level (a fixed spectrum look)
    tag_at = T(tag['at'])
    tag_cache = {}

    def tag_picture(tt):
        k = int(round(tt * 24000 / 1001))
        lv = float(level[k]) if 0 <= k < len(level) else 0.0
        q = round(lv * 12) / 12
        if q in tag_cache:
            return tag_cache[q]
        im = base_tag.copy()
        dd = ImageDraw.Draw(im)
        mx0, cy = tsz + tw + tsz, th / 2
        for i in range(bars):
            h = max(3.0, (th - 22) * q * shape[i])
            bx = mx0 + i * (bar_w + bar_gap)
            dd.rounded_rectangle([bx, cy - h / 2, bx + bar_w, cy + h / 2], radius=3, fill=stage.rgb('ink') + (255,))
        out = stage.shadowed(im.rotate(tag.get('rot', -3), expand=True, resample=Image.BICUBIC), look.R['card']['shadow'])[0]
        tag_cache[q] = out
        return out

    tx, ty = tag.get('pos', [x - 24, y - 40])
    tprobe = tag_picture(tag_at)
    self.safe_box(sid + '-tag', *self.opaque_box(tprobe, tx, ty), tag_at, t_out)

    def tag_dyn(tt):
        if tt < tag_at:
            return None, 0, 0
        u = (tt - tag_at) / 0.17  # slapped on: a quick overshoot, drawn on twos like the other the narrator tags
        if u < 1:
            s = C.ease_out_back(int(u * 0.17 / TWOS) * TWOS / 0.17)
            im = tag_picture(tt)
            w, h = max(1, int(im.width * s)), max(1, int(im.height * s))
            return im.resize((w, h), Image.LANCZOS), tx + (im.width - w) / 2, ty + (im.height - h) / 2
        if tt >= t_out:  # leaves with the card, after the film's end
            off = (tt - t_out) / 0.34
            if off >= 1:
                return None, 0, 0
            return tag_picture(tt), tx + (stage.W - tx + 60) * off * off, ty
        return tag_picture(tt), tx, ty

    sp = SmoothSprite(self, sid + '-tag', None, 0, 0, tag_at, 'none', 0, order=72, jitter=False)
    sp.dynamic = tag_dyn
    self.add(sp)

    # ---------------------------------------------------------------- the file card
    col_w = (W - 3 * 34) // 2
    ph = int(col_w * 0.74)
    y_cols = 46
    y_label = y_cols + ph + 22
    y_under = y_label + 52
    asz, rsz = ask.get('size', 46), reply.get('size', 30)
    fa, fl, fr = typewriter(asz), typewriter(e.get('label_px', 34)), typewriter(rsz)
    ask_lines = ask['text'].split('\n')
    y_ask = y_under + 86
    y_reply = y_ask + len(ask_lines) * int(asz * 1.25) + 26
    H = y_reply + rsz + 6 + 22 + rsz + 56
    card = K.paper(W, H, 'cream', seed=61, edge='straight')
    cx1, cx2 = 34, 34 * 2 + col_w

    photo = Image.open(v1['photo']).convert('RGB')
    if v1.get('crop'):
        photo = photo.crop(tuple(v1['crop']))
    photo = photo.resize((col_w - 16, ph - 16), Image.LANCZOS)

    t_v2, t_strike = T(v2['at']), T(v2['struck']['at'])
    t_v1, t_stamp = T(v1['at']), T(v1['stamp']['at'])
    t_ask, t_reply = T(ask['at']), T(reply['at'])
    cache = {}

    def frame_box(d, x0, dashed):
        if dashed:
            for k in range(0, col_w, 18):
                d.line([(x0 + k, y_cols), (x0 + min(k + 10, col_w), y_cols)], fill=K.INK + (200,), width=3)
                d.line([(x0 + k, y_cols + ph), (x0 + min(k + 10, col_w), y_cols + ph)], fill=K.INK + (200,), width=3)
            for k in range(0, ph, 18):
                d.line([(x0, y_cols + k), (x0, y_cols + min(k + 10, ph))], fill=K.INK + (200,), width=3)
                d.line([(x0 + col_w, y_cols + k), (x0 + col_w, y_cols + min(k + 10, ph))], fill=K.INK + (200,), width=3)

    def picture(tt):
        a2 = min(1.0, max(0.0, (tt - t_v2) / 0.25)) if tt >= t_v2 else 0.0
        st = min(1.0, max(0.0, (tt - t_strike) / 0.35)) if tt >= t_strike else 0.0
        a1 = min(1.0, max(0.0, (tt - t_v1) / 0.3)) if tt >= t_v1 else 0.0
        sm = min(1.0, max(0.0, (tt - t_stamp) / 0.14)) if tt >= t_stamp else 0.0
        aa = 1.0 if tt >= t_ask else 0.0
        ar = 1.0 if tt >= t_reply else 0.0
        key = (round(a2, 2), round(st, 2), round(a1, 2), round(sm, 2), aa, ar)
        if key in cache:
            return cache[key]
        im = card.copy()
        d = ImageDraw.Draw(im)
        if a2 > 0:  # version 2: nothing to show yet, a dashed empty frame and a typed question mark
            lay = Image.new('RGBA', im.size, (0, 0, 0, 0))
            ld = ImageDraw.Draw(lay)
            frame_box(ld, cx2, True)
            ld.text((cx2 + col_w / 2, y_cols + ph / 2), '?', font=typewriter(110), fill=K.INK + (220,), anchor='mm')
            ld.text((cx2, y_label), v2['label'], font=fl, fill=K.INK + (255,))
            ld.text((cx2, y_under), v2['struck']['text'], font=fl, fill=K.INK + (255,))
            lay.putalpha(lay.getchannel('A').point(lambda v: int(v * a2)))
            im.alpha_composite(lay)
            if st > 0:
                sw = fl.getlength(v2['struck']['text'])
                pts = [(cx2 - 6, y_under + 23), (cx2 + sw / 2, y_under + 21), (cx2 + sw + 8, y_under + 18)]
                C.marker_stroke(d, C.partial(pts, st), K.RED, 6, seed=11, alpha=215)  # thin, so the struck words stay readable
        if a1 > 0:  # version 1: the real photo, clipped on with a small drop
            lay = Image.new('RGBA', im.size, (0, 0, 0, 0))
            ld = ImageDraw.Draw(lay)
            ld.rectangle([cx1, y_cols, cx1 + col_w, y_cols + ph], fill=(250, 249, 244, 255))
            lay.paste(photo, (cx1 + 8, y_cols + 8))
            ld.text((cx1, y_label), v1['label'], font=fl, fill=K.INK + (255,))
            ld.rounded_rectangle([cx1 + 24, y_cols - 14, cx1 + 44, y_cols + 40], radius=8, outline=(150, 150, 156, 255), width=4)  # the clip
            drop = int((1 - C.ease_out_back(a1)) * -26)
            lay = lay.transform(lay.size, Image.AFFINE, (1, 0, 0, 0, 1, drop))
            lay.putalpha(lay.getchannel('A').point(lambda v: int(v * min(1.0, a1 * 2))))
            im.alpha_composite(lay)
        if sm > 0:  # the rubber stamp lands: big and faint to its size and full ink in 0.14 s
            fs = typewriter(64)
            st_im = Image.new('RGBA', (240, 110), (0, 0, 0, 0))
            sd = ImageDraw.Draw(st_im)
            sd.rounded_rectangle([6, 6, 234, 104], radius=10, outline=STAMP_BLUE + (255,), width=6)
            sd.text((120, 56), v1['stamp']['text'], font=fs, fill=STAMP_BLUE + (255,), anchor='mm')
            st_im = stage.apply_texture(st_im, 'sheet', 9, 0.5).rotate(-9, expand=True, resample=Image.BICUBIC)
            s = 1.25 - 0.25 * sm
            st_im = st_im.resize((int(st_im.width * s), int(st_im.height * s)), Image.LANCZOS)
            st_im.putalpha(st_im.getchannel('A').point(lambda v: int(v * (0.35 + 0.6 * sm))))
            im.alpha_composite(st_im, (int(cx1 + col_w / 2 - st_im.width / 2), int(y_cols + ph * 0.62 - st_im.height / 2)))
        if aa:
            for i, ln in enumerate(ask_lines):
                d.text((34, y_ask + i * int(asz * 1.25)), ln, font=fa, fill=K.INK + (255,))
        if ar:  # two empty ballot boxes, a tick and a cross drawn beside them (pictures, so no words to translate or source)
            bx, bs = 34, rsz + 6
            for mark in ('tick', 'cross'):
                d.rectangle([bx, y_reply, bx + bs, y_reply + bs], outline=K.INK + (255,), width=3)
                mx = bx + bs + 14
                if mark == 'tick':
                    d.line([(mx, y_reply + bs * 0.55), (mx + bs * 0.35, y_reply + bs * 0.9), (mx + bs * 0.9, y_reply + bs * 0.1)],
                           fill=(24, 138, 72, 255), width=5, joint='curve')
                else:
                    d.line([(mx, y_reply + bs * 0.1), (mx + bs * 0.8, y_reply + bs * 0.9)], fill=K.RED + (255,), width=5)
                    d.line([(mx + bs * 0.8, y_reply + bs * 0.1), (mx, y_reply + bs * 0.9)], fill=K.RED + (255,), width=5)
                bx = mx + bs + 40
            d.text((34, y_reply + bs + 22), reply['text'], font=fr, fill=K.INK + (255,))
        out = K.shadow(im.rotate(e.get('rot', 1.0), expand=True, resample=Image.BICUBIC))[0]
        if len(cache) > 14:
            cache.pop(next(iter(cache)))
        cache[key] = out
        return out

    C.slide(self, sid, picture, x, y, t_in, t_out, enter=e.get('enter', 'right'), exit=e.get('exit', 'right'), order=60,
            check=False)
    self.safe_box(sid, *self.opaque_box(picture(t_reply + 0.1), x, y), t_in, t_out)
    self.sound('card_in', t_in)
    self.sound('tag_slap', tag_at)
    for k, t in enumerate([t_v2, t_ask, t_reply]):
        self.sound(('click1', 'click2')[k % 2], t)
    self.sound('strike', t_strike)
    self.sound('clip_on', t_v1)
    self.sound('thump', t_stamp)
    self.sound('card_out', t_out)


def ev_taped_photo(self, e):
    """A real photo from the film taped onto a page (lane ch5, 12 C: version one, on his journal page). Paper world, so it is
    pressed on in two drawings (on twos, no motion blur: synthetic-4015c76f9424), a strip of translucent tape over each top
    corner, and it leaves the way its page leaves (up, eased in, exit_s) after `out`.

    {"type": "taped_photo", "id": "v1", "photo": path, "crop": [x0, y0, x1, y1], "pos": [x, y], "w": 400, "rot": 4,
     "at": s, "out": s, "exit_s": 0.45}"""
    sid = e.get('id', 'photo')
    w = e.get('w', 400)
    im = Image.open(e['photo']).convert('RGB')
    if e.get('crop'):
        im = im.crop(tuple(e['crop']))
    h = int(w * im.height / im.width)
    border = 14
    card = Image.new('RGBA', (w + 2 * border, h + 2 * border), (250, 249, 244, 255))
    card.paste(im.resize((w, h), Image.LANCZOS), (border, border))
    tape = Image.new('RGBA', (130, 40), (236, 228, 196, 150))
    for cx in (border + 10, w + border - 120):
        card.alpha_composite(tape.rotate(-14 if cx < w / 2 else 14, expand=True), (int(cx), -6 if cx < w / 2 else -10))
    card = stage.apply_texture(card, 'sheet', 13, 0.25)
    pic = K.shadow(card.rotate(e.get('rot', 4), expand=True, resample=Image.BICUBIC), soft=True)[0]
    x, y = e['pos']
    t_in, t_out, ex = self.T(e['at']), self.T(e['out']), e.get('exit_s', 0.45)
    self.safe_box(sid, *self.opaque_box(pic, x, y), t_in, t_out)
    big = pic.resize((int(pic.width * 1.06), int(pic.height * 1.06)), Image.LANCZOS)

    def dyn(tt):
        if tt < t_in:
            return None, 0, 0
        if tt < t_in + TWOS:  # the first drawing: lifted a little off the page, then pressed flat
            return big, x - (big.width - pic.width) / 2, y - (big.height - pic.height) / 2
        if tt < t_out:
            return pic, x, y
        u = (tt - t_out) / ex
        if u >= 1:
            return None, 0, 0
        return pic, x, y - (y + pic.height + 60) * u * u

    sp = SmoothSprite(self, sid, None, 0, 0, t_in, 'none', 0, order=e.get('order', 66), jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('peel', t_in)
