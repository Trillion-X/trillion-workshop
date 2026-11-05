"""peptide_takeover (lane ch3): a full-screen explainer takeover for a molecule he names (synthetic-ba30ed2f7cd2): hard cut to a dark
plate on the word, the name and what it is; the real amino-acid sequence threads on bead by bead as he says "chain"; what it
does, one line at a time; then where it sits between a peptide and a protein; hard cut back to him. His voice plays on
(technique: explainer takeover plate, Ali Abdaal step plates + Kurzgesagt bead molecules + 3Blue1Brown one-thing-at-a-time;
filmcraft/options-ch3/work/r2/pick-m11.md).

    {"type": "peptide_takeover", "id": "glp1", "at": s, "until": s, "title": "GLP-1",
     "lines": [{"text": "glucagon-like peptide-1", "at": s}, ...],                    under the title, each rising in on its cue
     "chain": {"at": s, "every_s": 0.03, "text": "HAEGTFTSDV...", "label": "...", "label_at": s},
     "effects": {"at": s, "heading": optional kicker, "rows": [{"text": "...", "at": s}, ...]},
     "scale": {"at": s, "lines": ["Peptide: ...", "Protein: ..."], "mark": 31, "max": 80, "label": "GLP-1", "label_at": s},
     "sounds": {"in": kind, "chain": kind, "rows": [kinds], "scale": kind}}

Cut in and out on the frame grid (no fade: the cut is the event). Drawn at every frame's exact time; the plate is opaque, so
nothing of the footage shows while it is up."""
import math
import os
import sys
from PIL import Image, ImageDraw
from overlay import stage
from overlay.kit import SmoothSprite
from overlay.stage import FPS
from overlay.helpers import paper_pieces as K
from overlay.helpers import peptide_beads as P

M = 150  # left margin of the plate's type
Y_BIG = 300  # top of the big title before the chain: the opening plate sits in the middle third


def ev_peptide_takeover(self, e):
    W, H = stage.W, stage.H
    T = self.T
    na, nu = round(T(e['at']) * FPS), round(T(e['until']) * FPS)
    ground = P.plate(W, H)
    title_big = P.text(e['title'], 'display_heavy', 200)
    title_small = P.text(e['title'], 'display_heavy', 84)
    lines = [(P.text(l['text'], 'display_semibold', 64 if k < 2 else 56, (196, 202, 212) if k == 0 else
                     (255, 255, 255) if k == 1 else P.AMBER), T(l['at'])) for k, l in enumerate(e.get('lines', []))]
    ch = e['chain']
    seq = ch['text']
    n = len(seq)
    r = 27
    xs = [M + r + (W - 2 * M - 2 * r) * k / (n - 1) for k in range(n)]
    ys = [470 + 46 * math.sin(2 * math.pi * 1.25 * k / (n - 1)) for k in range(n)]
    beads = [P.bead(r, a) for a in seq]
    t_chain, every = T(ch['at']), ch.get('every_s', 0.03)
    times = [t_chain + k * every for k in range(n)]
    label = (P.text(ch['label'], 'display_semibold', 58), T(ch['label_at']))
    ef = e['effects']
    t_ef = T(ef['at'])
    heading = P.text(ef['heading'].upper(), 'text_semibold', 34, P.AMBER) if ef.get('heading') else None
    rows = [(P.text(rw['text'], 'display_semibold', 62), T(rw['at'])) for rw in ef['rows']]
    sc = e['scale']
    t_sc, t_mark = T(sc['at']), T(sc['label_at'])
    sc_lines = [P.text(sc['lines'][0], 'display_semibold', 56, P.AMBER), P.text(sc['lines'][1], 'display_semibold', 56, (196, 202, 212))]
    mark_lab = P.text(sc['label'], 'display_bold', 50)
    t_up = t_chain - 0.35  # the title moves up out of the way of the chain

    def x_of(aa):
        return M + (W - 2 * M) * aa / sc.get('max', 80)

    def fade_out(img, t0, tt, dur=0.2):
        if tt < t0:
            return img
        u = min(1.0, (tt - t0) / dur)
        if u >= 1:
            return None
        out = img.copy()
        out.putalpha(out.getchannel('A').point(lambda v: int(v * (1 - u))))
        return out

    def place(fr, img, x, y, t0, tt, until=None):
        if img is None or tt < t0:
            return
        im, dy = P.rise(img, (tt - t0) / 0.28)
        if until is not None:
            im = fade_out(im, until, tt)
            if im is None:
                return
        fr.alpha_composite(im, (int(x), int(y + dy)))

    def layer(tt):
        k = round(self.t_exact * FPS)
        if k < na or k >= nu:
            return None, 0, 0
        tt = self.t_exact
        fr = ground.copy()
        # the title: big with the cut, then up to the top left as the chain starts
        u = 0.0 if tt < t_up else min(1.0, (tt - t_up) / 0.35)
        if u <= 0:
            fr.alpha_composite(title_big, (M - 10, Y_BIG))
        elif u < 1:
            e_ = K.ease_out(u)
            s = 1 + (title_small.height / title_big.height - 1) * e_
            im = title_big.resize((max(1, int(title_big.width * s)), max(1, int(title_big.height * s))), Image.BICUBIC)
            fr.alpha_composite(im, (int(M - 10 + 6 * e_), int(Y_BIG + (80 - Y_BIG) * e_)))
        else:
            fr.alpha_composite(title_small, (M - 4, 80))
        for j, (im, t0) in enumerate(lines):
            place(fr, im, M, [Y_BIG + 270, Y_BIG + 350, Y_BIG + 480][j], t0, tt, until=t_up)
        # the chain: the real sequence threads on, one bead at a time, left to right
        got = [kk for kk in range(n) if tt >= times[kk]]
        if got:
            d = ImageDraw.Draw(fr)
            d.line([(xs[kk], ys[kk]) for kk in got], fill=(150, 112, 70, 255), width=5, joint='curve')
            for kk in got:
                s = P.pop((tt - times[kk]) / 0.2)
                b = beads[kk] if abs(s - 1) < 0.01 else beads[kk].resize((max(1, int(beads[kk].width * s)),) * 2, Image.BICUBIC)
                fr.alpha_composite(b, (int(xs[kk] - b.width / 2), int(ys[kk] - b.height / 2)))
        place(fr, label[0], M, 600, label[1], tt, until=t_ef - 0.25)
        # what it does
        place(fr, heading, M, 600, t_ef, tt, until=t_sc - 0.3)
        for j, (im, t0) in enumerate(rows):
            if tt >= t0:
                place(fr, im, M + 60, 640 + j * 92, t0, tt, until=t_sc - 0.3)
                if tt < t_sc:
                    dd = ImageDraw.Draw(fr)
                    cy = 640 + j * 92 + im.height / 2
                    dd.ellipse([M + 6, cy - 12, M + 30, cy + 12], fill=P.AMBER + (255,))
        # peptide or protein: the length scale, with GLP-1 marked on it
        if tt >= t_sc:
            u = min(1.0, (tt - t_sc) / 0.45)
            e_ = K.ease_out(u)
            d = ImageDraw.Draw(fr)
            y = 830
            x0, x50, x1 = x_of(2), x_of(50), x_of(sc.get('max', 80))
            d.line([(x0, y), (x0 + (x50 - x0) * e_, y)], fill=P.AMBER + (255,), width=14)
            if e_ > 0.5:
                d.line([(x50 + 8, y), (x50 + 8 + (x1 - x50 - 8) * (e_ - 0.5) * 2, y)], fill=(110, 118, 130, 255), width=14)
            for xx in (x0, x50):
                d.line([(xx, y - 22), (xx, y + 22)], fill=(255, 255, 255, 255), width=4)
            place(fr, sc_lines[0], x0, y - 110, t_sc + 0.1, tt)
            place(fr, sc_lines[1], x50 + 30, y - 110, t_sc + 0.35, tt)
            if tt >= t_mark:
                um = min(1.0, (tt - t_mark) / 0.25)
                xm = x_of(sc['mark'])
                rr = 16 * P.pop(um)
                d.ellipse([xm - rr, y - rr, xm + rr, y + rr], fill=(255, 255, 255, 255), outline=P.AMBER + (255,), width=5)
                place(fr, mark_lab, xm - mark_lab.width / 2, y + 34, t_mark, tt)
        return fr, 0, 0

    sp = SmoothSprite(self, e.get('id', 'takeover'), None, 0, 0, (na - 0.25) / FPS, 'none', 0, order=90, jitter=False)
    sp.dynamic = layer
    self.add(sp)
    snd = e.get('sounds', {})
    t_cut = na / FPS
    if snd.get('in'):
        self.sound(snd['in'], t_cut)
    if snd.get('chain'):
        self.sound(snd['chain'], t_chain)
    for j, (im, t0) in enumerate(rows):
        if snd.get('rows'):
            self.sound(snd['rows'][j % len(snd['rows'])], t0)
    if snd.get('scale'):
        self.sound(snd['scale'], t_sc)
