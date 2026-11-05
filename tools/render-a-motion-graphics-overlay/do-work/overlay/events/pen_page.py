"""pen_page (lane ch5): handwriting written on stroke by stroke, the way a pen moves, as he says it or into a silence: on a
journal page that slides in, or straight over the footage in white marker (technique: handwritten write-on; the stroke
order is the glyph's own skeleton walked from its left end, so ink appears along the line a pen would draw, not as a wipe;
library/techniques/handwritten-write-on.md). One real marker-on-paper recording plays while each line is written,
cut to that line's writing time (synthetic-99c2095c6735).

    {"type": "pen_page", "id": "ps", "journal": true | false, "pos": [x, y], "size": [w, h] (journal only),
     "at": s, "out": s, "enter": "bottom" | "none", "exit": "up" | "fall" | "right" | ...,
     "lines": [{"text": "P.S.", "at": s, "dur": s, "font": "PermanentMarker-Regular.ttf", "px": 90, "xy": [x, y]}]}

xy is the line's top-left inside the page (or inside the element box when journal is false). Over footage the ink is white with
the soft wide shadow (synthetic-4b111b631333); on the journal page it is dark ink.
exit "unwrite" takes the ink back off along the same path in reverse (last stroke first) over unwrite_s, with the marker
sound again: a written mark leaves the way it came, and nothing small flies across the frame (film-qa exits follows shapes
by overlap, and a full stop moving 50 px a frame has none).
exit_s (a moving exit): the exit starts exit_s before `out`, so the piece has left by `out`; film-qa face reads exactly
that window (out - exit_s .. out) as the exit of a covers_a_roll page.

A legal pad sheet ("legal": true, with "size"): yellow ruled paper, a double red margin, a straight-cut sheet with the soft
card shadow; it slides in and out by _ch5_kit.slide (eased, still while up, motion blur along the travel) with the card_in /
card_out sounds, at "enter" / "exit" edges. Its lines (and any journal line) may also carry:
    "colour": [r, g, b]                   the ink (default the paper's ink)
    "beats": [[n, at, dur], ...]          write the line in parts as he says them: by `at` ink runs on, over `dur`, up to the
                                          end of the line's first n characters (counts, never strings: every string is words)
    "underline": {"at", "dur", "colour"}  a marker stroke drawn under the line once written (a sum bar, an emphasis)
    "ring": {"at", "dur", "colour"}       a marker loop drawn round the line
A line whose writing ends before the page's "at" is on the page when it arrives (a printed label) and makes no sound."""
import os
import subprocess
import sys
import wave
import numpy as np
from PIL import Image, ImageDraw
from overlay import kit
from overlay import look, stage
from overlay.helpers import paper_pieces as K
from overlay.helpers import slide_pieces as C

# writing passages in that recording (seconds), measured by RMS over 0.1 s windows (-30 to -50 dBFS while the marker moves)
PASSAGES = [(4.9, 5.8), (9.1, 9.9), (11.9, 13.4), (20.5, 21.6), (28.0, 29.5), (0.2, 0.8)]
# synthetic-5fb3433e1b41: the raw whiteboard marker is a squeak (spectral centroid 6.1 kHz, 54% of its energy above 4 kHz); heard
# through this filter it is a soft felt tip on paper (centroid 1.9 kHz, 5% above 4 kHz), the rub without the scratch
FELT = 'highpass=f=160,lowpass=f=2400,lowpass=f=2400,equalizer=f=1200:t=q:w=1:g=-3'


def stroke_order(mask):
    """mask (bool HxW) -> float array: for every ink pixel its place (0..1) along the pen's path, NaN elsewhere. Each
    connected glyph part is skeletonised; the skeleton is walked depth-first from its left-most end; parts are written
    left to right; every ink pixel takes the place of its nearest skeleton pixel."""
    from scipy import ndimage
    from skimage.morphology import skeletonize
    lab, n = ndimage.label(mask)
    boxes = ndimage.find_objects(lab)
    parts = sorted(range(1, n + 1), key=lambda i: boxes[i - 1][1].start)
    sk = skeletonize(mask)
    order = np.full(mask.shape, -1.0)
    k = 0
    for i in parts:
        pts = set(zip(*np.nonzero(sk & (lab == i))))
        if not pts:
            pts = set(zip(*np.nonzero(lab == i)))
        nb = lambda p: [(p[0] + dy, p[1] + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if (dy or dx) and (p[0] + dy, p[1] + dx) in pts]
        ends = [p for p in pts if len(nb(p)) <= 1] or list(pts)
        while pts:
            start = min((p for p in ends if p in pts), key=lambda p: (p[1], p[0]), default=None) or min(pts, key=lambda p: (p[1], p[0]))
            stack = [start]
            while stack:
                p = stack.pop()
                if p not in pts:
                    continue
                pts.discard(p)
                order[p] = k
                k += 1
                stack.extend(sorted(nb(p), key=lambda q: -q[1]))
    if k == 0:
        return np.full(mask.shape, np.nan)
    _, idx = ndimage.distance_transform_edt(order < 0, return_indices=True)
    near = order[idx[0], idx[1]] / k
    return np.where(mask, near, np.nan)


def ev_pen_page(self, e):
    sid = e.get('id', 'pen')
    journal = bool(e.get('journal'))  # a boolean, not a string: every string on an event is read as on-screen words
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    if e.get('exit') != 'unwrite' and 'exit_s' in e:
        t_out -= e['exit_s']
    legal = bool(e.get('legal'))
    if legal:
        W, H = e['size']
        page = legal_sheet(W, H, e.get('seed', 29))
    elif journal:
        W, H = e['size']
        page = Image.new('RGBA', (W, H), stage.rgb('paper_white') + (255,))
        page = stage.apply_texture(page, 'sheet', 41, 0.3)
        d = ImageDraw.Draw(page)
        for y in range(150, H - 30, 64):  # blue rules under the written lines, a red margin
            d.line([(0, y), (W, y)], fill=(150, 178, 214, 255), width=2)
        d.line([(96, 0), (96, H)], fill=(214, 120, 118, 255), width=3)
        m = Image.new('L', (W, H), 0)
        ImageDraw.Draw(m).polygon(stage.torn_polygon(W, H, 4, 17, step=9), fill=255)
        page.putalpha(m)
    else:
        W, H = e.get('size', [stage.W, stage.H])
        page = None
    ink = (30, 32, 44) if legal else (34, 32, 30) if journal else (255, 255, 255)
    lines = []
    for ln in e['lines']:
        fnt = K.face(ln.get('font', 'PermanentMarker-Regular.ttf'), ln.get('px', 64))
        bb = fnt.getbbox(ln['text'])
        mw, mh = bb[2] - bb[0] + 8, bb[3] - bb[1] + 8
        mk = Image.new('L', (mw, mh), 0)
        ImageDraw.Draw(mk).text((4 - bb[0], 4 - bb[1]), ln['text'], font=fnt, fill=255)
        mask = np.asarray(mk) > 110
        order = stroke_order(mask)
        beats = []  # (start, dur, from fraction, to fraction): the pen path is left to right, so a prefix ends where its ink ends
        frac0 = 0.0
        for n, at, dur in ln['beats'] if 'beats' in ln else [[len(ln['text']), ln['at'], ln['dur']]]:
            right = 4 - bb[0] + fnt.getlength(ln['text'][:n])
            done = order[:, :max(1, int(right))]
            frac1 = 1.0 if n >= len(ln['text']) else float(np.nanmax(done)) if np.isfinite(done).any() else frac0
            beats.append((self.T(at), dur, frac0, frac1))
            frac0 = frac1
        L = {'order': order, 'xy': ln['xy'], 'beats': beats, 'size': (mw, mh), 'ink': tuple(ln.get('colour', ink))}
        L['end'] = max(a + d for a, d, _, _ in beats)
        L['printed'] = L['end'] <= t_in
        x0, y0 = ln['xy']
        for mark in ('underline', 'ring'):
            if ln.get(mark):
                m = ln[mark]
                if mark == 'underline':
                    pts = [(x0 + 2, y0 + mh + 4), (x0 + mw * 0.55, y0 + mh + 7), (x0 + mw + 6, y0 + mh + 3)]
                else:  # a loop round the line: starts top-left, goes round once and overlaps its start a little
                    cx, cy, rx, ry = x0 + mw / 2, y0 + mh / 2, mw / 2 + 22, mh / 2 + 16
                    pts = [(cx + rx * np.cos(a) * (1 + 0.04 * np.sin(3 * a)), cy + ry * np.sin(a)) for a in np.linspace(-2.5, -2.5 + 2 * np.pi * 1.08, 40)]
                L[mark] = {'pts': pts, 'at': self.T(m['at']), 'dur': m['dur'], 'colour': tuple(m.get('colour', L['ink'])), 'width': m.get('width', 7)}
        lines.append(L)
    cache = {}

    def progress(L, tt):
        p = 0.0
        for a, d, f0, f1 in L['beats']:
            if tt >= a:
                p = f0 + (f1 - f0) * min(1.0, (tt - a) / d)
        return p

    unwrite = e.get('exit') == 'unwrite'
    us = e.get('unwrite_s', 0.6)

    def picture(tt):
        prog = tuple(round(progress(L, tt), 3) for L in lines) + tuple(
            round(min(1.0, max(0.0, (tt - L[m]['at']) / L[m]['dur'])), 3) for L in lines for m in ('underline', 'ring') if m in L)
        if unwrite and tt >= t_out:
            back = (tt - t_out) / us
            if back >= 1:
                return None
            prog = tuple(round(p * (1 - back), 3) for p in prog)
        if prog in cache:
            return cache[prog]
        im = page.copy() if page is not None else Image.new('RGBA', (W, H), (0, 0, 0, 0))
        for L, p in zip(lines, prog):
            if p <= 0:
                continue
            a = (np.nan_to_num(L['order'], nan=2.0) <= p).astype(np.uint8) * 255
            lay = Image.new('RGBA', L['size'], L['ink'] + (255,))
            lay.putalpha(Image.fromarray(a))
            im.alpha_composite(lay, tuple(int(v) for v in L['xy']))
        marks = [L[m] for L in lines for m in ('underline', 'ring') if m in L]
        dd = ImageDraw.Draw(im)
        for M, p in zip(marks, prog[len(lines):]):
            if p > 0:
                C.marker_stroke(dd, C.partial(M['pts'], p), M['colour'], M['width'], seed=11)
        out = stage.shadowed(im, look.R['card']['shadow'] if page is not None else look.LOOK['text_shadow'])[0]
        if len(cache) > 8:
            cache.pop(next(iter(cache)))
        cache[prog] = out
        return out
    x, y = e['pos']
    kind = 'pen-' + sid
    spans = [(a, d) for L in lines if not L['printed'] for a, d, _, _ in L['beats']]
    spans += [(L[m]['at'], L[m]['dur']) for L in lines for m in ('underline', 'ring') if m in L]
    if legal:
        C.slide(self, sid, picture, x, y, t_in, t_out, enter=e.get('enter', 'right'), exit=e.get('exit', 'right'),
                order=e.get('order', 62), check=e.get('check', True))
        self.sound('card_in', t_in)
        self.extra_sounds[kind] = [{'file': marker_track(self, kind, t_in, sorted(spans)), 'gain_db': 0}]
        self.sound(kind, t_in)
        self.sound('card_out', t_out)
        return
    spans = [(L['beats'][0][0], L['end'] - L['beats'][0][0]) for L in lines]
    if e.get('check', True):  # the finished page or line against the title-safe area
        self.safe_box(sid, *self.opaque_box(picture(t_out - 0.01), x, y), t_in, t_out)
    K.moving(self, sid, picture, x, y, t_in, t_out + us + 1e3 if unwrite else t_out, enter=e.get('enter', 'bottom' if journal else 'none'),
             exit='up' if unwrite else e.get('exit', 'up'), order=e.get('order', 62), drift=False, smooth=True, check=False, paper_exits=True)
    if journal and e.get('enter', 'bottom') != 'none':
        self.sound('slide_in', t_in)
    spans += [(t_out, us)] if unwrite else []
    self.extra_sounds[kind] = [{'file': marker_track(self, kind, t_in, spans), 'gain_db': 0}]
    self.sound(kind, t_in)
    if not unwrite:
        K.leave_sound(self, e.get('exit', 'up'), t_out, e.get('exit_sound', 'slide_out'))


def legal_sheet(W, H, seed):
    """A yellow legal pad sheet: pale blue rules every 52 px under a deeper top band, the double red margin, paper texture, a
    straight cut edge (torn off the pad along its perforation: the top edge is a fine row of nicks)."""
    page = Image.new('RGBA', (W, H), (253, 243, 168, 255))
    d = ImageDraw.Draw(page)
    for y in range(78, H - 20, 52):
        d.line([(0, y), (W, y)], fill=(140, 176, 210, 255), width=2)
    for x in (58, 66):
        d.line([(x, 0), (x, H)], fill=(222, 112, 106, 255), width=2)
    page = stage.apply_texture(page, 'sheet', seed, 0.3)
    m = Image.new('L', (W, H), 255)
    md = ImageDraw.Draw(m)
    for x in range(0, W, 9):  # perforation nicks along the top
        md.rectangle([x, 0, x + 3, 2], fill=0)
    page.putalpha(m)
    return page


def marker_track(self, kind, t0, spans):
    """One wav from t0: for each (start, seconds) a different writing passage of the marker recording, softened to a felt
    tip (FELT), cut to that length with 30 ms fades (synthetic-99c2095c6735)."""
    sr = 48000
    raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', look.asset(look.section('pen_page')['marker_sound']), '-af', FELT, '-ac', '2', '-ar', str(sr), '-f', 's16le', '-'],
                         capture_output=True, check=True).stdout
    y = np.frombuffer(raw, np.int16).astype(np.float32).reshape(-1, 2) / 32768.0
    n = int((max(a + d for a, d in spans) - t0 + 0.5) * sr)
    out = np.zeros((n, 2), np.float32)
    g = 10 ** (self.shot.get('pen_gain_db', 6) / 20)
    for k, (a, d) in enumerate(spans):
        p0, p1 = PASSAGES[k % len(PASSAGES)]
        # a line longer than its passage plays on through the recording (its own pen lifts and restarts), never a loop
        # of the same passage (synthetic-2e04fec90d12)
        seg = y[int(p0 * sr):int((p0 + d) * sr)].copy()
        f = min(len(seg) // 2, int(0.03 * sr))
        seg[:f] *= np.linspace(0, 1, f)[:, None]
        seg[-f:] *= np.linspace(1, 0, f)[:, None]
        s = int((a - t0) * sr)
        m = min(len(seg), n - s)
        out[s:s + m] += seg[:m] * g
    path = look.out_path(kind + '.wav')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(out, -1, 1) * 32767).astype(np.int16).tobytes())
    return path
