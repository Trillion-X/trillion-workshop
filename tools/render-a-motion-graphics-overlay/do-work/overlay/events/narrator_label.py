"""narrator_label (lane ch2, round 2): the narrator's own label, so it is plain that the narrator is here (the person's rules narrator-moments-special).
The same kraft strip and typewriter face as his chapter-1 narrator tag ("narrated by Sam", render_correction
ev_narrator_tag), so his look stays consistent while his entrance changes from moment to moment (synthetic-4494bd6b35a5 keeps
type and colour). Paper world, so it moves on twos with no motion blur (synthetic-4015c76f9424): it is slapped on with a
small overshoot and slides off the frame in steps.

    {"type": "narrator_label", "id": "tag", "words": "narrated by Sam", "pos": [x, y], "rot": -3, "size": 30,
     "at": s, "out": s, "out_dir": "E", "sounds": {"in": "slide_in", "out": "slide_out"}}

Without "sounds" the tag plays chapter 2's palette classes ch2_card and ch2_out (earshot-bank sounds made or fitted in code)."""
from PIL import Image, ImageDraw
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, compass, ease_in
from overlay.helpers.sound_classes import play
TWOS = 2 * 1001 / 24000      # one drawing held for two frames


def _on_twos(t):
    return int(t / TWOS) * TWOS


def ev_narrator_label(self, e):
    sid = e.get('id', 'narrator-label')
    size = e.get('size', 30)
    f = stage.font(look.R['fonts']['typewriter'], size)
    tw = f.getlength(e['words'])
    w, h = int(tw + 2 * size), int(size * 1.9)
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon(stage.torn_polygon(w, h, 4, 5, step=7), fill=stage.rgb('kraft') + (238,))
    d.text((size, h / 2), e['words'], font=f, fill=stage.rgb('ink') + (255,), anchor='lm')
    img = stage.apply_texture(img, 'kraft', 5).rotate(e.get('rot', 0), expand=True, resample=Image.BICUBIC)
    img, pad = stage.shadowed(img, look.R['card']['shadow'])
    x, y = e['pos']
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    ox, oy = compass(e.get('out_dir', 'E'))
    self.safe_box(sid, x, y, x + img.width - 2 * pad, y + img.height - 2 * pad, t_in, t_out)

    def dyn(tt):
        if tt < t_in:
            return None, 0, 0
        ts = _on_twos(tt - t_in)
        if tt >= t_out:
            u = ease_in(_on_twos(tt - t_out) / 0.5)
            if u >= 1:
                return None, 0, 0
            return img, x - pad + ox * u, y - pad + oy * u
        # slapped on: three drawings, a touch big, then a touch small, then home
        s = 1.12 if ts < TWOS else 0.97 if ts < 2 * TWOS else 1.0
        if s == 1.0:
            return img, x - pad, y - pad
        im = img.resize((int(img.width * s), int(img.height * s)), Image.BICUBIC)
        return im, x - pad - (im.width - img.width) / 2, y - pad - (im.height - img.height) / 2

    sp = SmoothSprite(self, sid, None, 0, 0, t_in, 'none', 0, order=80, jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    snd = e.get('sounds')
    if snd:   # r3 sound kinds (look_r3.json), real catalogued recordings, so the tag's sounds can carry a credit row (content check S6.5)
        self.sound(snd['in'], t_in)
        self.sound(snd['out'], t_out)
        return
    play(self, 'ch2_card', t_in, 0.35)
    play(self, 'ch2_out', t_out)
