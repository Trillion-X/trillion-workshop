"""graph_paper_map (round 8, the narrator's analysis beat, option C): the Not My Business graph-paper marker layer, measured on two videos
(library/formats/itsnotmybusiness/, rows in library/devices/creator-deconstruction-2026-10-23.md), with his question as the diagram.

  DV207 hand-drawn marker layer (0Rqoe5quCJQ, native 644.14-648.56 s, row line 235): a pointer arrow starts 0.25 s before the first
      letter stroke; the word is written over about 1.0 s; the underline comes 0.626 s after the word is complete and is drawn in
      about 0.04 s; the sheet then holds 2.5 s before the cut. Here: arrow 0.25 s, letters 1.0 s, pause 0.626 s, underline 0.06 s.
  DV746 correct a qualifier while preserving the diagram (same video, row line 197): the diagram stays put while one word of it
      changes. Here: the map of his question stays where it is; three wider hand-drawn rings are added round it as the question
      grows, and the ice cream node is struck through, not redrawn.
  DV747 accumulate icons then reveal a central consequence panel (same video, 423.30-430.05 s, row line 239): items crowd in one by
      one, then one panel lands in the middle and holds (1.71 s measured). Here: micronutrients, minerals and hormones crowd in
      round the ice cream; one white panel with the one question lands in the middle and holds to the end.

    {"type": "graph_paper_map", "id": "gp", "at": [w, off], "out": [w, off], "until": s,   (until: the cover ends here, for film-qa)
     "center": [960, 560], "core": {"text": "ice cream", "at": [w, off], "oval_at": [w, off]},
     "nodes": [{"text": "micronutrients", "at": [w, off], "pos": [x, y]}, ...],   pos: centre of the word; 'at' is the first letter stroke
     "rings": [{"at": [w, off], "rx": 700, "ry": 380}, ...], "strike_at": [w, off],
     "panel": {"lines": [...], "at": [w, off], "top": 330}}
The whole sheet is one full-frame picture drawn at every frame's own time (smooth), slid in from the right and out to the right."""
import math
import os
import sys
import numpy as np
from PIL import Image, ImageDraw
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, ease_out, ease_in
from overlay.helpers import paper_pieces as K
from overlay.helpers.writing_sounds import write_sound

ARROW_S, WORD_S, PAUSE_S, UNDER_S = 0.25, 1.0, 0.626, 0.06   # DV207, measured
SLIDE_S = 0.34
FACE = 'Kalam-Bold.ttf'
W, H = 1920, 1080


def _graph_paper(seed):
    im = K.paper(W, H, 'cream', seed, edge='straight')
    d = ImageDraw.Draw(im)
    for x in range(0, W, 48):
        d.line([(x, 0), (x, H)], fill=(168, 196, 224, 255), width=2 if x % 240 == 0 else 1)
    for y in range(0, H, 48):
        d.line([(0, y), (W, y)], fill=(168, 196, 224, 255), width=2 if y % 240 == 0 else 1)
    return im


def _ellipse(cx, cy, rx, ry, frac, seed, width, colour):
    rng = np.random.default_rng(seed)
    wob = rng.uniform(-0.016, 0.016, 5)
    th0 = math.radians(200 + seed * 29)
    n = max(2, int(200 * frac))
    pts = []
    for i in range(n):
        th = th0 + 2 * math.pi * 1.07 * i / 199
        k = 1 + sum(w * math.sin((j + 2) * th + j) for j, w in enumerate(wob))
        pts.append((cx + rx * k * math.cos(th), cy + ry * k * math.sin(th)))
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(im).line(pts, fill=colour + (235,), width=width, joint='curve')
    return im


def ev_graph_paper_map(self, e):
    sid = e.get('id', 'gp')
    cx, cy = e['center']
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    self.seed += 1
    paper = _graph_paper(self.seed)
    red = K.RED
    size = e.get('size', 84)
    core = e['core']
    core_img = K.hand(core['text'], FACE, int(size * 1.15))
    core_pos = (cx - core_img.width // 2, cy - core_img.height // 2)
    t_core, t_oval = self.T(core['at']), self.T(core['oval_at'])
    nodes = []
    for n in e['nodes']:
        img = K.hand(n['text'], FACE, size)
        x, y = n['pos'][0] - img.width // 2, n['pos'][1] - img.height // 2
        under = Image.new('RGBA', (img.width, 14), (0, 0, 0, 0))
        ImageDraw.Draw(under).line([(2, 9), (img.width - 4, 5)], fill=red + (255,), width=7)
        t0 = self.T(n['at'])
        nodes.append({'img': img, 'xy': (x, y), 't0': t0, 'under': under, 'c': n['pos']})
    rings = [{'t': self.T(r['at']), 'rx': r['rx'], 'ry': r['ry']} for r in e['rings']]
    t_strike = self.T(e['strike_at'])
    pn = e['panel']
    body = K.hand('\n'.join(pn['lines']), FACE, pn.get('size', 76))
    pad = 44
    pw, ph = body.width + 2 * pad, body.height + 2 * pad
    self.seed += 1
    panel = K.paper(pw, ph, 'white', self.seed, edge='torn')
    panel.alpha_composite(body, (pad, pad))
    panel, ppad = K.shadow(panel)
    t_panel = self.T(pn['at'])
    t_under = self.T(pn['under_at'])
    UNDER_P = 0.45
    last = K.hand(pn['lines'][-1], FACE, pn.get('size', 76))
    under_panel = Image.new('RGBA', (last.width, 14), (0, 0, 0, 0))
    ImageDraw.Draw(under_panel).line([(2, 9), (last.width - 4, 5)], fill=K.RED + (255,), width=8)
    pxy = ((W - pw) // 2 - ppad, pn['top'] - ppad)
    cache = {}

    def arrow_img(c, f):
        """A pointer from just outside the core oval toward the node, drawn to fraction f, with an arrowhead at the end."""
        x0, y0 = cx + (c[0] - cx) * 0.34, cy + (c[1] - cy) * 0.34
        x1, y1 = cx + (c[0] - cx) * 0.74, cy + (c[1] - cy) * 0.74
        xe, ye = x0 + (x1 - x0) * f, y0 + (y1 - y0) * f
        im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.line([(x0, y0), (xe, ye)], fill=K.INK + (255,), width=7)
        if f >= 1:
            a = math.atan2(y1 - y0, x1 - x0)
            for s in (-0.5, 0.5):
                d.line([(x1, y1), (x1 - 34 * math.cos(a + s), y1 - 34 * math.sin(a + s))], fill=K.INK + (255,), width=7)
        return im

    def sheet(tt):
        key = []
        key.append(round(min(max((tt - t_core) / WORD_S, 0), 1), 1))
        key.append(round(min(max((tt - t_oval) / 0.5, 0), 1), 1))
        for n in nodes:
            key.append((round(min(max((tt - n['t0'] + ARROW_S) / ARROW_S, 0), 1), 1), round(min(max((tt - n['t0']) / WORD_S, 0), 1), 1),
                        round(min(max((tt - n['t0'] - WORD_S - PAUSE_S) / UNDER_S, 0), 1), 1)))
        for r in rings:
            key.append(round(min(max((tt - r['t']) / 0.6, 0), 1), 1))
        key.append(round(min(max((tt - t_strike) / 0.4, 0), 1), 1))
        key.append(round(min(max((tt - t_under) / UNDER_P, 0), 1), 1))
        key.append(0 if tt < t_panel else round(min((tt - t_panel) / 0.18, 1), 2))
        key = tuple(key)
        if key in cache:
            return cache[key]
        im = Image.new("RGBA", (W, H), (0, 0, 0, 0))  # the map alone, so it can fade when the panel lands
        im.alpha_composite(K.reveal(core_img, key[0]), core_pos) if key[0] > 0 else None
        if key[1] > 0:
            im.alpha_composite(_ellipse(cx, cy, core_img.width * 0.62, core_img.height * 0.82, key[1], 1, 7, red), (0, 0))
        for i, n in enumerate(nodes):
            fa, fw, fu = key[2 + i]
            if fa > 0:
                im.alpha_composite(arrow_img(n['c'], fa), (0, 0))
            if fw > 0:
                im.alpha_composite(K.reveal(n['img'], fw), n['xy'])
            if fu > 0:
                im.alpha_composite(K.reveal(n['under'], fu), (n['xy'][0], n['xy'][1] + n['img'].height - 6))
        for j, r in enumerate(rings):
            f = key[2 + len(nodes) + j]
            if f > 0:
                im.alpha_composite(_ellipse(cx, cy, r['rx'], r['ry'], f, 3 + j, 6, K.INK), (0, 0))
        f_st = key[-3]
        if f_st > 0:
            y = cy + 4
            ImageDraw.Draw(im).line([(core_pos[0] - 14, y + 10), (core_pos[0] + (core_img.width + 28) * f_st, y - 10)], fill=red + (255,), width=10)
        if key[-1] > 0:  # DV747: the map recedes (to 30%) as the one panel lands in the middle
            a = np.asarray(im).copy()
            a[..., 3] = (a[..., 3] * (1 - 0.7 * min(1.0, key[-1] * 2))).astype(np.uint8)
            im = Image.fromarray(a, "RGBA")
        out = paper.copy()
        out.alpha_composite(im)
        im = out
        if key[-1] > 0:
            u = key[-1]
            s = 1.12 - 0.12 * ease_out(u)
            p = panel.resize((int(panel.width * s), int(panel.height * s)), Image.LANCZOS)
            p.putalpha(p.getchannel('A').point(lambda v, a=min(1.0, u * 3): int(v * a)))
            im.alpha_composite(p, (pxy[0] + (panel.width - p.width) // 2, pxy[1] + (panel.height - p.height) // 2))
            if key[-2] > 0:  # a red underline under the question's last line, written on after the panel has landed
                im.alpha_composite(K.reveal(under_panel, key[-2]), (pxy[0] + ppad + pad + 4, pxy[1] + ppad + pad + body.height + 2))
        cache.clear()
        cache[key] = im
        return im

    def dyn(tt):
        if tt < t_in:
            return None, 0, 0
        dx = (1 - ease_out(min((tt - t_in) / SLIDE_S, 1.0))) * W
        if tt >= t_out:
            u = ease_in((tt - t_out) / SLIDE_S)
            if u >= 1:
                return None, 0, 0
            dx = u * W
        return sheet(tt), dx, 0
    sp = SmoothSprite(self, sid, None, 0, 0, t_in, 'none', 0, order=e.get('order', 55), jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    # boxes for film-qa placement: the full-frame sheet is a declared cover (covers_a_roll in the spec); the panel is its own box, inside the title-safe area
    self.boxes.append((sid, t_in, t_out, 0, 0, W, H))
    self.safe_box(sid + '-panel', pxy[0] + ppad, pxy[1] + ppad, pxy[0] + ppad + pw, pxy[1] + ppad + ph, t_panel, t_out)
    # a box for every element, from the time it starts to the time the sheet leaves (nothing on the sheet moves once drawn; the ink grows inside its box,
    # so the box is its final extent): core word and its oval, each pointer and word with its underline, each ring, the strike. Not title-safe-checked: the
    # sheet is a full-frame cover and its rings run to the frame edge on purpose.
    self.boxes.append((sid + '-core', t_core, t_out, core_pos[0], core_pos[1], core_pos[0] + core_img.width, core_pos[1] + core_img.height))
    self.boxes.append((sid + '-oval', t_oval, t_out, cx - core_img.width * 0.62, cy - core_img.height * 0.82, cx + core_img.width * 0.62, cy + core_img.height * 0.82))
    for i, n in enumerate(nodes):
        x, y = n['xy']
        self.boxes.append((f'{sid}-word{i}', n['t0'], t_out, x, y, x + n['img'].width, y + n['img'].height + 14))
        c = n['c']
        ax0, ay0, ax1, ay1 = cx + (c[0] - cx) * 0.34, cy + (c[1] - cy) * 0.34, cx + (c[0] - cx) * 0.74, cy + (c[1] - cy) * 0.74
        self.boxes.append((f'{sid}-pointer{i}', n['t0'] - ARROW_S, t_out, min(ax0, ax1) - 34, min(ay0, ay1) - 34, max(ax0, ax1) + 34, max(ay0, ay1) + 34))
    for j, r in enumerate(rings):
        self.boxes.append((f'{sid}-ring{j}', r['t'], t_out, cx - r['rx'], cy - r['ry'], cx + r['rx'], cy + r['ry']))
    self.boxes.append((sid + '-strike', t_strike, t_out, core_pos[0] - 14, cy - 10, core_pos[0] + core_img.width + 14, cy + 20))
    self.sound('slide_in', t_in)
    k = 0
    write_sound(self, k, t_oval)
    for n in nodes:
        k += 1
        write_sound(self, k, n['t0'] - ARROW_S)
        k += 1
        write_sound(self, k, n['t0'])
    for r in rings:
        k += 1
        write_sound(self, k, r['t'])
    k += 1
    write_sound(self, k, t_strike)
    self.sound('paper', t_panel)
    self.sound('slide_out', t_out)
