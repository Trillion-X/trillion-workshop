"""The `note` event. Ported from narrator/tools/render_correction.py:552."""
import numpy as np
from PIL import Image, ImageDraw

from overlay import look, stage


def ev_note(self, e):
    fnt = stage.font(look.R['fonts']['marker'], e['size'] * stage.K)
    tw = fnt.getlength(e['text']); asc, desc = fnt.getmetrics()
    full = Image.new('RGBA', (int(tw + 20 * stage.K), int(asc + desc + 20 * stage.K)), (0, 0, 0, 0))
    ImageDraw.Draw(full).text((10 * stage.K, 10 * stage.K), e['text'], font=fnt, fill=stage.rgb(e.get('colour', 'ink')) + (255,))
    rot = e.get('rot', 0)
    t = self.T(e['at'])
    dur = max(0.3, len(e['text']) / 22)
    cache = {}

    def dyn(tt):
        fr = round(min(1.0, (tt - t) / dur), 2)
        if fr not in cache:
            im = full.copy()
            cut = int(im.width * fr)
            a = np.asarray(im.getchannel('A')).copy(); a[:, cut:] = 0
            im.putalpha(Image.fromarray(a))
            cache[fr] = im.rotate(-rot, expand=True, resample=Image.BICUBIC)
        return cache[fr], e['pos'][0] * stage.K, e['pos'][1] * stage.K
    sp = stage.Sprite(e.get('id', 'note'), None, 0, 0, t, 'none', 0, order=75)
    sp.dynamic = dyn
    self.add(sp)
    self.sound('marker', t)
    if e.get('arrow'):
        self.ev_arrow(dict(e['arrow']), t=t + dur * 0.8, sid=e.get('id', 'note') + '-arrow')
