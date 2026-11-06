"""strata_descent: a chain of reasons drawn as a dig down through the ground, so going deeper is seen as depth. A paper card
shows the ground in section: as he says each step, a red marker drill pushes down into a new layer of earth under the last
one, the layer darker the deeper it lies, carrying his words; a floor of rock can land under the layers, and the drill
strikes it and bounces back off it (it cannot go any further). Things made along the way can spin off the shaft as kraft
tags at their layer's depth, and leave by lifting up out of the frame on the word that releases them.
Techniques: cross-section diagram (the layered cut-away of textbook geology and the Vox "show the mechanism, not the words"
move, as in goal_tracks and energy_budget), progressive disclosure on the spoken word (stamp_steps rows, numbered-steps-stamp),
callback (DV519: the same card returns later with the layers already dug), source-result mapping (branch_map) for the spin-offs.

    {"type": "strata_descent", "id": "dig", "pos": [x, y], "w": 560, "title": "ASKING WHY", "at": s, "out": s,
     "enter": "left", "exit": "fall" | "crumple" | "tear" | "left" | ...,
     "layer_h": 86,
     "layers": [{"text": "why is it raining?", "at": s}, ...],      a layer whose at is not after the card's at is already dug
     "deeper": {"text": "many layers deep", "at": s},               optional: a dashed red line on down past the last layer
     "floor": {"text": "BEDROCK", "at": s, "hits": [s, ...]},       optional: the rock lands; the drill strikes it at each hit
     "spin_w": 300, "spin_title": {"text": "...", "at": s},         optional column of spin-offs right of the layers
     "spinoffs": [{"text": "...", "layer": 2, "at": s}, ...],       layer: the index of the layer the tag leaves from
     "release_at": s}                                               optional: the tags lift up out of the frame

Palette only (ink, kraft, cream, white, the accent red): layers are kraft mixed into cream, the rock is ink with a kraft
hatch. Paper world: drawn on twos, still while up; sounds are the real paper recordings of r3's sound map (thump per layer,
per strike and for the rock; pops for the tags; an air whoosh for the release)."""
import math
import os
import sys
import numpy as np
from PIL import Image, ImageDraw
from overlay import stage
from overlay.helpers import paper_pieces as K

DIG_S = 0.35          # the drill pushes into a new layer over this long, the layer opening top-down with it
FLOOR_DROP_S = 0.14   # the rock lands
HIT_S = 0.22          # one strike: the bit kicks back off the rock and settles
HIT_KICK_PX = 16
POP_S = 0.24          # a spin-off's line draws, then its tag pops on
RISE_PX_S2 = 2600     # released tags lift away, accelerating


def _mix(a, b, f):
    return tuple(int(round(a[i] * (1 - f) + b[i] * f)) for i in range(3))


def _wavy(d, y, x0, x1, seed, amp=3.0, colour=K.INK, width=3):
    ph = (seed * 1.7) % 6.28
    pts = [(x, y + amp * math.sin(x / 37.0 + ph) + 0.6 * amp * math.sin(x / 11.0 + 2 * ph)) for x in range(int(x0), int(x1) + 1, 6)]
    d.line(pts, fill=colour + (255,), width=width)


def ev_strata_descent(self, e):
    sid = e.get('id', 'dig')
    W, LH, pad = e['w'], e.get('layer_h', 86), 30
    SW = e.get('spin_w', 0) if e.get('spinoffs') else 0
    title_f = K.face('CourierPrime-Bold.ttf', e.get('title_px', 34))
    label_f = K.face('SpecialElite-Regular.ttf', e.get('label_px', 27))
    tag_f = 'Kalam-Bold.ttf'
    layers, floor, deeper = e['layers'], e.get('floor'), e.get('deeper')
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    title_h = int(title_f.size * 1.3)
    y_g = pad + title_h + 26                       # the ground line
    sx = pad + 44                                  # the shaft
    tops = [y_g + k * LH for k in range(len(layers))]
    y_f = y_g + len(layers) * LH                   # the rock's top (or where the dug layers end)
    floor_h = 96 if floor else 0
    deep_h = int(LH * 0.9) if deeper and not floor else 0
    H = y_f + floor_h + deep_h + pad
    M = int(e['pos'][1]) + 220 if e.get('release_at') else 0   # room above the card for released tags to leave the frame
    label_x = sx + 36
    if title_f.getlength(e['title']) > W + SW - 2 * pad:
        raise SystemExit(f'{sid}: the title is {title_f.getlength(e["title"]):.0f}px wide; the card fits {W + SW - 2 * pad}px')
    for L in layers:
        if label_f.getlength(L['text']) > W - label_x - pad:
            raise SystemExit(f'{sid}: "{L["text"]}" is {label_f.getlength(L["text"]):.0f}px wide; a layer fits {W - label_x - pad}px')

    self.seed += 1
    seed = self.seed
    card = K.paper(W + SW, H, 'white', seed, edge='straight')
    d = ImageDraw.Draw(card)
    d.text((pad, pad), e['title'], font=title_f, fill=K.INK + (255,))
    _wavy(d, y_g, pad - 6, W - pad + 6, seed, amp=2.0)
    for gx in range(pad, W - pad, 23):             # tufts on the surface, so the top line reads as ground
        d.line([(gx, y_g - 2), (gx - 4, y_g - 11)], fill=K.INK + (255,), width=2)
        d.line([(gx + 3, y_g - 2), (gx + 5, y_g - 9)], fill=K.INK + (255,), width=2)

    cream, kraft = stage.rgb('paper_cream'), stage.rgb('kraft')

    def band(k):
        """Layer k as its own image (W x LH): kraft mixed into cream, darker the deeper; its lower edge wavy; its words."""
        im = Image.new('RGBA', (W, LH + 6), (0, 0, 0, 0))
        dd = ImageDraw.Draw(im)
        fill = _mix(cream, kraft, min(0.95, 0.3 + 0.2 * k))
        dd.rectangle([pad - 6, 0, W - pad + 6, LH], fill=fill + (255,))
        rng = np.random.default_rng(seed * 31 + k)  # grains of earth
        for gx, gy in zip(rng.uniform(pad, W - pad, 26), rng.uniform(6, LH - 8, 26)):
            dd.ellipse([gx, gy, gx + 3, gy + 2], fill=_mix(fill, K.INK, 0.35) + (255,))
        _wavy(dd, LH, pad - 6, W - pad + 6, seed + k + 1)
        dd.text((label_x, LH / 2), layers[k]['text'], font=label_f, fill=K.INK + (255,), anchor='lm')
        return im
    bands = [band(k) for k in range(len(layers))]
    t_layer = [max(t_in, self.T(L['at'])) for L in layers]

    rock = None
    if floor:
        rock = Image.new('RGBA', (W, floor_h), (0, 0, 0, 0))
        dr = ImageDraw.Draw(rock)
        rw, rh = W - 2 * pad + 12, floor_h - 4
        hatch = Image.new('RGBA', (rw, rh), _mix(K.INK, cream, 0.12) + (255,))
        dh = ImageDraw.Draw(hatch)
        for hx in range(-rh, rw, 18):  # a kraft cross-hatch: rock in a section drawing
            dh.line([(hx, rh), (hx + rh, 0)], fill=kraft + (255,), width=2)
            dh.line([(hx + 9, 0), (hx + 9 + rh, rh)], fill=_mix(kraft, K.INK, 0.4) + (255,), width=2)
        rock.alpha_composite(hatch, (pad - 6, 0))
        dr.rectangle([pad - 6, 0, W - pad + 6, floor_h - 4], outline=K.INK + (255,), width=3)
        rf = K.face('BlackOpsOne-Regular.ttf', e.get('floor_px', 44))
        tw = rf.getlength(floor['text'])
        lx = (W + label_x) / 2 - tw / 2
        dr.rectangle([lx - 14, floor_h / 2 - rf.size * 0.62, lx + tw + 14, floor_h / 2 + rf.size * 0.62], fill=_mix(K.INK, cream, 0.12) + (255,))
        dr.text((lx, floor_h / 2), floor['text'], font=rf, fill=cream + (255,), anchor='lm')
        t_floor = max(t_in, self.T(floor['at']))
        hits = [self.T(h) for h in floor.get('hits', [])]

    note = None
    if deeper:
        note = K.hand(deeper['text'], tag_f, e.get('deeper_px', 26), K.RED)
        t_deeper = max(t_in, self.T(deeper['at']))

    spins = []
    for S in e.get('spinoffs', []):
        tag_txt = K.hand(S['text'], tag_f, e.get('tag_px', 26))
        self.seed += 1
        tag = K.paper(min(SW - 30, tag_txt.width + 26), tag_txt.height + 16, 'kraft', self.seed, edge='torn')
        tag.alpha_composite(tag_txt, (13, 8))
        if tag_txt.width + 26 > SW - 30:
            raise SystemExit(f'{sid}: spin-off "{S["text"]}" is {tag_txt.width}px wide; the column fits {SW - 56}px')
        cy = tops[S['layer']] + LH * 0.8   # under the layer's words, so the line never runs through them
        spins.append({'tag': K.shadow(tag, soft=True), 'cy': cy, 't': max(t_in, self.T(S['at']))})
    spin_title = None
    if e.get('spin_title'):
        spin_title = (K.hand(e['spin_title']['text'], 'SpecialElite-Regular.ttf', 22, (110, 108, 102)), self.T(e['spin_title']['at']))
    t_rel = self.T(e['release_at']) if e.get('release_at') else None

    def depth(tt):
        """Where the drill tip is: the bottom of the deepest layer dug so far, pushed in over DIG_S; the rock's top once it lands."""
        y = float(y_g)
        for k, tl in enumerate(t_layer):
            if tt >= tl:
                y = tops[k] + (LH - 14) * K.ease_out(min(1.0, (tt - tl) / DIG_S))
        if rock is not None and tt >= t_floor:
            y = y_f - 2
            for h in hits:
                if h <= tt < h + HIT_S:
                    y -= HIT_KICK_PX * math.sin(math.pi * (tt - h) / HIT_S)
        return y

    cache = {}

    def picture(tt):
        dug = tuple(round(min(1.0, (tt - tl) / DIG_S), 2) if tt >= tl else -1 for tl in t_layer)
        fl = round(min(1.0, (tt - t_floor) / FLOOR_DROP_S), 2) if rock is not None and tt >= t_floor else -1
        struck = sum(1 for h in hits if tt >= h) if rock is not None else 0
        dn = round(min(1.0, (tt - t_deeper) / 0.6), 2) if note is not None and tt >= t_deeper else -1
        sp = tuple(round(min(1.0, (tt - s['t']) / POP_S), 2) if tt >= s['t'] else -1 for s in spins)
        rel = round(tt - t_rel, 2) if t_rel is not None and tt >= t_rel else -1
        tip = round(depth(tt))
        st = round(min(1.0, (tt - spin_title[1]) / 0.6), 2) if spin_title is not None and tt >= spin_title[1] else -1
        key = (dug, fl, struck, dn, sp, rel, tip, st)
        if key in cache:
            return cache[key]
        im = card.copy()
        for k, f in enumerate(dug):
            if f < 0:
                continue
            b = bands[k] if f >= 1 else bands[k].crop((0, 0, W, max(1, int((LH + 6) * K.ease_out(f)))))  # opens top-down with the drill
            im.alpha_composite(b, (0, tops[k]))
        if fl >= 0:
            drop = int((1 - K.ease_in(fl)) * -18)
            im.alpha_composite(rock, (0, y_f + drop))
        dd = ImageDraw.Draw(im)
        dd.line([(sx, y_g - 4), (sx, tip)], fill=K.RED + (255,), width=7)         # the shaft, red marker
        dd.polygon([(sx - 13, tip - 14), (sx + 13, tip - 14), (sx, tip + 10)], fill=K.RED + (255,))
        for n in range(struck):                    # each strike leaves a crack in the rock's top
            cx = sx + (n % 2) * 10 - 5
            dd.line([(cx, y_f + 2), (cx - 16 + 6 * n, y_f + 22), (cx - 24 + 6 * n, y_f + 30)], fill=cream + (255,), width=3)
            dd.line([(cx, y_f + 2), (cx + 14 - 4 * n, y_f + 18)], fill=cream + (255,), width=3)
        if dn >= 0:                                 # on down: a dashed line past the last layer, and his words beside it
            y0, y1 = y_f + 4, y_f + 4 + (deep_h - 20) * dn
            for yy in range(int(y0), int(y1), 16):
                dd.line([(sx, yy), (sx, min(yy + 9, y1))], fill=K.RED + (255,), width=5)
            if dn >= 1:
                dd.polygon([(sx - 10, y1 - 8), (sx + 10, y1 - 8), (sx, y1 + 6)], fill=K.RED + (255,))
            im.alpha_composite(K.reveal(note, dn), (label_x, int(y_f + (deep_h - note.height) / 2)))
        if st >= 0:
            im.alpha_composite(K.reveal(spin_title[0], st), (W + 8, max(6, tops[0] - spin_title[0].height - 10)))
        if rel < 0:                                  # spin-offs on the card until they are released
            for s, f in zip(spins, sp):
                if f < 0:
                    continue
                tg, tpad = s['tag']
                x_end = W + 12
                xe = sx + (x_end - sx) * min(1.0, f * 2)
                dd.line([(sx + 6, s['cy']), (xe, s['cy'])], fill=K.INK + (255,), width=3)
                if f >= 0.5:
                    sc = 1.12 if f < 0.75 else 1.0
                    t2 = tg.resize((int(tg.width * sc), int(tg.height * sc)), Image.BICUBIC) if sc != 1.0 else tg
                    im.alpha_composite(t2, (int(x_end - tpad), int(s['cy'] - t2.height / 2)))
        out = K.shadow(im)[0]
        if M or rel >= 0:
            canvas = Image.new('RGBA', (out.width, out.height + M), (0, 0, 0, 0))
            canvas.alpha_composite(out, (0, M))
            if rel >= 0:                             # released: the tags lift up and out of the frame
                lift = 0.5 * RISE_PX_S2 * rel * rel
                for k, s in enumerate(spins):
                    tg, tpad = s['tag']
                    ty = M + s['cy'] - tg.height / 2 - lift * (1 + 0.25 * k)
                    if ty + tg.height > 0:
                        canvas.alpha_composite(tg, (int(W + 12 - tpad + 18 * k * rel), int(ty)))
            out = canvas
        if len(cache) > 40:
            cache.pop(next(iter(cache)))
        cache[key] = out
        return out

    x, y = e['pos']
    K.moving(self, sid, picture, x, y - M, t_in, t_out, enter=e.get('enter', 'left'), exit=e.get('exit', 'left'), order=60, drift=False,
             paper_exits=True)
    if e.get('enter', 'left') != 'none':
        self.sound('slide_in', t_in)
    for tl in t_layer:
        if tl > t_in:
            self.sound('thump', tl)
    if rock is not None:
        if t_floor > t_in:
            self.sound('thump', t_floor)
        for h in hits:
            self.sound('thump', h)
    for k, s in enumerate(spins):
        if s['t'] > t_in:
            self.sound('pop2' if k % 2 == 0 else 'pop3', s['t'] + POP_S / 2)
    if t_rel is not None:
        self.sound('exit_air', t_rel)
    K.leave_sound(self, e.get('exit', 'left'), t_out)
