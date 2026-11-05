"""The `bfull` event. Ported from filmcraft/options-ch1/tools-round-2/r2.py:768."""
from PIL import Image, ImageDraw

from overlay import kit, look, stage


# ---------- B-roll full frame ----------
def ev_bfull(self, e):
    """Muted B-roll filling the frame from e.at to e.until. With e.shrink_at it shrinks into a photo print at
    e.print (x, y, w) with a label, and the A-roll shows again around it."""
    frames = kit.clip_frames(e['src'], e['start'], e['dur'], e.get('speed', 1.0), size=(stage.W, stage.H))
    t, until = self.T(e['at']), self.T(e['until'])
    shrink = self.T(e['shrink_at']) if e.get('shrink_at') is not None else None
    P = look.LOOK['print']

    def layer(tt):
        i = min(int(max(0, tt - t) * stage.FPS / stage.HOLD), len(frames) - 1)
        f = frames[i]
        if shrink is None or tt < shrink:
            return f.convert('RGBA'), 0, 0
        u = stage.ease_out((tt - shrink) / 0.45)
        px, py, pw = e['print']
        ph = int(pw * stage.H / stage.W)
        w = int(stage.W + (pw - stage.W) * u)
        h = int(stage.H + (ph - stage.H) * u)
        b = int(P['border_px'] * u)
        lb = int(P['label_border_px'] * u)
        im = Image.new('RGBA', (w + 2 * b, h + b + lb), stage.rgb('paper_white') + (255,))
        im.paste(f.resize((w, h), Image.BILINEAR), (b, b))
        if u > 0.95 and e.get('label'):
            fnt = kit.sf('text_semibold', e.get('label_px', P['label_px']))
            ImageDraw.Draw(im).text((im.width / 2, h + b + lb / 2), e['label'], font=fnt, fill=kit.col('ink') + (255,), anchor='mm')
        rot = e.get('rot', 0) * u
        if rot:
            im = im.rotate(-rot, expand=True, resample=Image.BICUBIC)
        if u > 0.05:
            im, pad = stage.shadowed(im, look.R['card']['shadow'])
        else:
            pad = 0
        x = 0 + (px - 0) * u - pad
        y = 0 + (py - 0) * u - pad
        return im, x, y
    sp = stage.Sprite(e.get('id', 'bfull'), None, 0, 0, t, 'none', 0, order=e.get('order', 1), jitter=False)
    sp.dynamic = layer
    sp.until = until - 0.12 if e.get('exit') != 'slide' else None
    if e.get('exit') == 'slide':
        sp.t_out, sp.out_dx, sp.out_dy = until, 1300, 0
    self.add(sp)
    if shrink is not None:
        self.sound('slide_in', shrink)
    if e.get('exit') == 'slide':
        self.sound('slide_out', until)
