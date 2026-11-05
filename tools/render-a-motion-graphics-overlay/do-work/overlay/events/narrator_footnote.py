"""narrator_footnote (lane ch2, round 2): the narrator's written aside. An asterisk lands on the word he says, the way a
footnote mark sits on a word in print; a few seconds later, once he has moved on, the footnote itself comes up in the
corner and says, flat, what he left out. Techniques: the deadpan footnote or caption gag (the narrator who corrects the
host in text, as in Arrested Development's on-screen notes and documentary lower-third asides); British narration's
understatement ("said plainly, then stop", narrator/CHARACTER.md); the print footnote's mark-then-note grammar.
Write-up: filmcraft/options-ch2/techniques/narrator-footnote.md.

The mark is white SF Pro over footage with the soft shadow and motion blur (events/_ch2_motion.py). The note is typed on
The narrator's kraft paper, the look of his "narrated by Sam" tag, so it is plainly his and reads on a light wall or a dark
cabinet alike; as paper it moves on twos, without blur.

    {"type": "narrator_footnote", "id": "fn", "glyph": "*", "mark_at": s, "glyph_pos": [x, y],
     "words": "* He does not say\\nwhat the solution is.", "at": s, "out": s, "right": x, "bottom": y, "size": 40, "rot": 1.5}"""
from PIL import Image, ImageDraw
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, ease_in, ease_out
from overlay.helpers.motion_smear import smeared
from overlay.helpers.sound_classes import play


def ev_narrator_footnote(self, e):
    sid = e.get('id', 'footnote')
    white = kit.col('white')
    t_glyph, t_in, t_out = self.T(e['mark_at']), self.T(e['at']), self.T(e['out'])

    # ---- the mark on the word
    gim, gp = kit.text_img(e['glyph'], kit.sf('display_bold', e.get('glyph_size', 72)), white)
    gx, gy = e['glyph_pos']
    gw, gh = gim.width - 2 * gp, gim.height - 2 * gp
    self.safe_box(sid + '-mark', gx, gy, gx + gw, gy + gh, t_glyph, t_out)

    def leave_up(tt):
        if tt < t_out:
            return 0.0, 0.0
        u = ease_in((tt - t_out) / 0.4)
        return (None, None) if u >= 1 else (0.0, -(gy + gh + 120) * u)

    def glyph_dyn(tt):
        dx, dy = leave_up(tt)
        if dx is None or tt < t_glyph:
            return None, 0, 0
        u = ease_out((tt - t_glyph) / 0.22)
        img = gim
        if u < 1:
            img = gim.copy()
            img.putalpha(gim.getchannel('A').point(lambda v: int(v * u)))
        return img, gx - gp + dx, gy - gp + (1 - u) * -16 + dy
    s = SmoothSprite(self, sid + '-mark', None, 0, 0, t_glyph, 'none', 0, order=72, jitter=False)
    s.dynamic = smeared(glyph_dyn, leave_up)
    self.add(s)
    play(self, 'ch2_in', t_glyph)

    # ---- the note in the corner: typed on the narrator's kraft paper (his tag's look), a short ink rule above it as in print.
    # Paper, so it moves on twos with no motion blur (synthetic-4015c76f9424), and it reads on any backing.
    size = e.get('size', 40)
    f = stage.font(look.R['fonts']['typewriter'], size)
    lines = e['words'].split('\n')
    asc, desc = f.getmetrics()
    lh = int((asc + desc) * 1.08)
    padx, pady, rule_h, gap = int(size * 0.8), int(size * 0.55), 4, int(size * 0.35)
    w = int(max(f.getlength(l) for l in lines)) + 2 * padx
    h = pady + rule_h + gap + lh * len(lines) + pady
    paper = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(paper)
    d.polygon(stage.torn_polygon(w, h, 4, 9, step=7), fill=stage.rgb('kraft') + (242,))
    ink = stage.rgb('ink') + (255,)
    d.rectangle([padx, pady, padx + int(size * 3.2), pady + rule_h], fill=ink)
    for i, l in enumerate(lines):
        d.text((padx, pady + rule_h + gap + i * lh), l, font=f, fill=ink)
    paper = stage.apply_texture(paper, 'kraft', 9).rotate(e.get('rot', 1.5), expand=True, resample=Image.BICUBIC)
    layer, tp = stage.shadowed(paper, look.R['card']['shadow'])
    pw, ph = paper.width, paper.height
    x0 = e['right'] - pw
    y0 = e['bottom'] - ph
    self.safe_box(sid + '-note', x0, y0, e['right'], e['bottom'], t_in, t_out)
    twos = 2 * 1001 / 24000

    def note_dyn(tt):
        if tt < t_in:
            return None, 0, 0
        if tt >= t_out:  # slides down off the frame in drawings held for two frames
            u = ease_in((int((tt - t_out) / twos) * twos) / 0.45)
            if u >= 1:
                return None, 0, 0
            return layer, x0 - tp, y0 - tp + (stage.H - y0 + 120) * u
        k = int((tt - t_in) / twos)  # slapped on: a touch big, a touch small, home
        s = 1.08 if k == 0 else 0.98 if k == 1 else 1.0
        if s == 1.0:
            return layer, x0 - tp, y0 - tp
        im = layer.resize((int(layer.width * s), int(layer.height * s)), Image.BICUBIC)
        return im, x0 - tp - (im.width - layer.width) / 2, y0 - tp - (im.height - layer.height) / 2
    n = SmoothSprite(self, sid + '-note', None, 0, 0, t_in, 'none', 0, order=72, jitter=False)
    n.dynamic = note_dyn
    self.add(n)
    play(self, 'ch2_card', t_in, 0.35)
    play(self, 'ch2_out', t_out)
