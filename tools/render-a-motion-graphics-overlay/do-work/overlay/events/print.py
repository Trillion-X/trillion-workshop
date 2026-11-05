"""The `print` event. Ported from filmcraft/options-ch1/tools-round-3/r3.py:187."""
from PIL import Image, ImageDraw

from overlay import kit, look, stage


# ---------- print with scrapbook edge, its own label face, footage at the film's frame rate ----------
def ev_print(self, e):
    P = look.LOOK['print']
    w = e['w']
    h = int(w * e.get('aspect', 0.72))
    edge = e.get('edge', 'straight')
    b = max(P['border_px'], look.LOOK3['edges'][edge].get('border_px', P['border_px']))
    label = e.get('label')
    lsize = e.get('label_px', P['label_px'])
    lfont = e.get('label_font', 'text_semibold')
    lb = P['label_border_px'] + (b - P['border_px']) if label else b
    if label:
        fnt = kit.face(lfont, lsize)
        if fnt.getlength(label) > w - 16 and ' ' in label:  # two balanced lines before any shrinking
            ws = label.split(' ')
            k = min(range(1, len(ws)), key=lambda j: max(fnt.getlength(' '.join(ws[:j])), fnt.getlength(' '.join(ws[j:]))))
            label = ' '.join(ws[:k]) + '\n' + ' '.join(ws[k:])
            lb += int(lsize * 1.15)
        while max(fnt.getlength(x) for x in label.split('\n')) > w - 8 and lsize > 16:
            lsize -= 1
            fnt = kit.face(lfont, lsize)
    src = e['src']
    reader, still = None, None
    if 'image' in src:
        im = Image.open(src['image']).convert('RGB')
        if src.get('crop'):
            im = im.crop(tuple(src['crop']))
        still = kit.cover(im, w, h, tuple(src.get('focus', (0.5, 0.5))))
    else:
        reader = kit.ClipReader(src['video'], src['start'], (w, h), crop=src.get('crop'), speed=src.get('speed', 1.0))
        n_src = int(src['dur'] * stage.FPS)
    self.seed += 1
    tpl = Image.new('RGBA', (w + 2 * b, h + b + lb), stage.rgb('paper_white') + (255,))
    tpl = stage.apply_texture(tpl, 'sheet', self.seed, 0.22)
    tpl.putalpha(kit.edge_mask(tpl.width, tpl.height, edge, self.seed + 31))
    if label:
        ImageDraw.Draw(tpl).multiline_text((tpl.width / 2, h + b + lb / 2), label, font=fnt, fill=kit.col('ink') + (255,), anchor='mm', align='center', spacing=2)
    rot = e.get('rot', 0)
    t = self.T(e['at'])
    cache = {}

    def card(i):
        if i not in cache:
            c = tpl.copy()
            c.paste(still if reader is None else reader.get(i), (b, b))
            c = c.rotate(-rot, expand=True, resample=Image.BICUBIC)
            if reader is not None:
                cache.clear()
            cache[i] = stage.shadowed(c, look.R['card']['shadow'])
        return cache[i]
    c0, pad0 = card(0)
    x0, y0 = e['pos'][0] - pad0, e['pos'][1] - pad0
    self.safe_box(e.get('id', 'print'), *self.opaque_box(c0, x0, y0), t)

    def dyn(tt):
        i = 0
        if reader is not None:
            i = int(max(0.0, self.t_exact - t) * stage.FPS)  # footage inside a frame plays every frame
            i = i % n_src if src.get('loop', False) else min(i, n_src - 1)
        c, pad = card(i)
        return c, e['pos'][0] - pad, e['pos'][1] - pad
    sp = stage.Sprite(e.get('id', 'print'), None, 0, 0, t, 'slam', P['slam_s'], order=e.get('order', 65), jitter=e.get('jitter', False))
    self.paper_motion(sp, e, t)
    sp.dynamic = dyn
    if e.get('until') is not None:
        sp.until = self.T(e['until'])
    self.add(sp)
    self.sound(e.get('sound', 'shutter'), t)
    return sp
