"""proglucagon_cut (lane ch3): a peptide shown as a piece cut out of a longer chain. A dark card unfolds beside him; the
peptide's real sequence threads on bead by bead; the camera pulls back so the beads shrink into their place inside the longer
parent chain (the rest of it fading in grey); then the peptide's beads lift out of the parent as one short chain, with what
makes it a peptide rather than a protein (technique: zoom-out reveal of scale, the Powers of Ten / Kurzgesagt pull-back, on a
bead molecule; filmcraft/options-ch3/work/r2/pick-m11.md).

    {"type": "proglucagon_cut", "id": "proglucagon", "pos": [x, y], "w": 600, "h": 760, "at": s, "out": s,
     "title": "GLP-1", "label": "a chain of 30 or 31 amino acids",
     "chain": {"at": s, "every_s": 0.03, "text": "HAEG..."},
     "parent": {"at": s, "length": 180, "start": 98, "label": "cut from a longer chain: ..."},
     "lift": {"at": s, "lines": ["Peptide: ...", "Protein: ..."]},
     "sounds": {"open", "chain", "parent", "lift", "close"}}

The card opens and closes as a vertical unfold from its middle line (0.35 s / 0.3 s), drawn at every frame's exact time; it
sits still while it is up (synthetic-469527071d0e)."""
import os
import sys
from PIL import Image, ImageDraw
from overlay import stage
from overlay.helpers import paper_pieces as K
from overlay.helpers import peptide_beads as P

PAD = 40


def _serpentine(n, per_row, x0, x1, y0, dy):
    out = []
    for i in range(n):
        row, col = divmod(i, per_row)
        if row % 2:
            col = per_row - 1 - col
        out.append((x0 + (x1 - x0) * col / (per_row - 1), y0 + row * dy))
    return out


def ev_proglucagon_cut(self, e):
    W, H = e['w'], e['h']
    T = self.T
    t_in, t_out = T(e['at']), T(e['out'])
    t_close = t_out + 0.3
    ch, pa, li = e['chain'], e['parent'], e['lift']
    seq = ch['text']
    n = len(seq)
    t_chain, every = T(ch['at']), ch.get('every_s', 0.03)
    times = [t_chain + k * every for k in range(n)]
    t_par, t_lift = T(pa['at']), T(li['at'])
    big_r, small_r = 15, 6
    big = _serpentine(n, 16, PAD + big_r, W - PAD - big_r, 300, 74)
    total, start = pa['length'], pa['start']
    small = _serpentine(total, 30, PAD + small_r, W - PAD - small_r, 250, 34)
    mine = [small[start - 1 + k] for k in range(n)]
    lifted = [(W / 2 - (n - 1) * 8 + 16 * k, 600) for k in range(n)]
    beads = [P.bead(big_r, a, letter_px=16) for a in seq]
    dot_amber = P.bead(small_r, None)
    dot_grey = P.bead(small_r, None, P.GREY)
    title = P.text(e['title'], 'display_heavy', 72)
    label = P.text(e['label'], 'display_semibold', 36, (196, 202, 212))
    plabel = P.text(pa['label'], 'display_semibold', 36)
    llines = [P.text(li['lines'][0], 'display_semibold', 36, P.AMBER), P.text(li['lines'][1], 'display_semibold', 36, (196, 202, 212))]
    card = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(card).rounded_rectangle([0, 0, W - 1, H - 1], radius=26, fill=P.INK_BG + (232,), outline=(255, 255, 255, 46), width=2)

    def lerp(a, b, u):
        return a + (b - a) * u

    def picture(tt):
        if tt >= t_close:
            return None
        im = card.copy()
        d = ImageDraw.Draw(im)
        im.alpha_composite(title, (PAD - 6, 26))
        fade = 1.0 if tt < t_par else max(0.0, 1 - (tt - t_par) / 0.25)
        if fade > 0:
            lb, dy = P.rise(label, (tt - t_chain) / 0.3)
            if fade < 1:
                lb = lb.copy()
                lb.putalpha(lb.getchannel('A').point(lambda v: int(v * fade)))
            if tt >= t_chain:
                im.alpha_composite(lb, (PAD - 6, 120 + dy))
        u_par = 0.0 if tt < t_par else K.ease_out(min(1.0, (tt - t_par) / 0.7))
        u_lift = 0.0 if tt < t_lift else K.ease_out(min(1.0, (tt - t_lift) / 0.6))
        if u_par > 0:  # the parent chain: grey line and dots fade in around the peptide's place
            g = min(1.0, max(0.0, (tt - t_par - 0.25) / 0.45))
            if g > 0:
                runs = [small] if u_lift == 0 else [small[:start - 1], small[start - 1 + n:]]  # lifted out: a gap is left
                for run in runs:
                    if len(run) > 1:
                        d.line(run, fill=(90, 96, 108, int(255 * g)), width=3, joint='curve')
                for i, p in enumerate(small):
                    if start - 1 <= i < start - 1 + n:
                        continue
                    dg = dot_grey.copy()
                    dg.putalpha(dg.getchannel('A').point(lambda v: int(v * g)))
                    im.alpha_composite(dg, (int(p[0] - small_r), int(p[1] - small_r)))
                pl, dy = P.rise(plabel, (tt - t_par - 0.4) / 0.3)
                if tt >= t_par + 0.4:
                    im.alpha_composite(pl, (PAD - 6, 460 + dy))
        pos = []
        for k in range(n):
            if tt < times[k]:
                break
            p = big[k]
            if u_par > 0:
                p = (lerp(p[0], mine[k][0], u_par), lerp(p[1], mine[k][1], u_par))
            if u_lift > 0:
                p = (lerp(p[0], lifted[k][0], u_lift), lerp(p[1], lifted[k][1], u_lift))
            pos.append(p)
        if len(pos) > 1:
            d.line(pos, fill=(150, 112, 70, 255), width=4 if u_par < 0.5 else 3, joint='curve')
        r_now = lerp(big_r, small_r, u_par) + (8 - small_r) * u_lift
        for k, p in enumerate(pos):
            if u_par < 0.5:
                s = P.pop((tt - times[k]) / 0.2) * r_now / big_r
                b = beads[k] if abs(s - 1) < 0.01 else beads[k].resize((max(1, int(beads[k].width * s)),) * 2, Image.BICUBIC)
            else:
                s = r_now / small_r
                b = dot_amber if abs(s - 1) < 0.01 else dot_amber.resize((max(1, int(dot_amber.width * s)),) * 2, Image.BICUBIC)
            im.alpha_composite(b, (int(p[0] - b.width / 2), int(p[1] - b.height / 2)))
        if u_lift > 0:
            for j, ln in enumerate(llines):
                lt, dy = P.rise(ln, (tt - t_lift - 0.35 - 0.25 * j) / 0.3)
                if tt >= t_lift + 0.35 + 0.25 * j:
                    im.alpha_composite(lt, (PAD - 6, 640 + 46 * j + dy))
        # open and close: a vertical unfold from the card's middle line
        o = min(1.0, (tt - t_in) / 0.35) if tt < t_out else max(0.0, 1 - (tt - t_out) / 0.3)
        o = K.ease_out(o) if tt < t_out else K.ease_in(o)
        if o < 1:
            hh = max(2, int(H * o))
            m = Image.new('L', (W, H), 0)
            ImageDraw.Draw(m).rectangle([0, (H - hh) // 2, W, (H + hh) // 2], fill=255)
            a = im.getchannel('A')
            im.putalpha(Image.composite(a, Image.new('L', (W, H), 0), m))
        return stage.shadowed(im, {'dx': 0, 'dy': 10, 'blur': 26, 'opacity': 0.35})[0]
    x, y = e['pos']
    _, sp_pad = stage.shadowed(card, {'dx': 0, 'dy': 10, 'blur': 26, 'opacity': 0.35})
    self.safe_box(e.get('id', 'card'), x, y, x + W, y + H, t_in, t_close)
    K.moving(self, e.get('id', 'card'), picture, x - sp_pad, y - sp_pad, t_in, t_close + 1.0, enter='none', exit='right', order=60,
             drift=False, check=False, smooth=True)
    snd = e.get('sounds', {})
    for key, t in (('open', t_in), ('chain', t_chain), ('parent', t_par), ('lift', t_lift), ('close', t_out)):
        if snd.get(key):
            self.sound(snd[key], t)
