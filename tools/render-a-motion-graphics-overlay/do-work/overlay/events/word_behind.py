"""word_behind (lane ch1 cold opens, round 8): the huge word behind the speaker (device DV194, itsnotmybusiness/2OVcY7KfgPQ, CIS F-0267, library/devices/
creator-deconstruction-2026-10-23.md line 237: large type fills the frame and the speaker stands in front of it, the title clearing with the scene cut). The words are
paper-word blocks as in the row (white paper, heavy black capitals with an offset dark edge, each word its own block) in a layer over the footage that has a hole where the speaker stands: each frame's alpha is the word's alpha times (1 - his person matte), so his own pixels show through
and nothing of him is covered (synthetic-73042df8cd3b). The matte is the shape of the speaker cut from the real picture of that frame (person_matte.py, Apple Vision, accurate).
The words are static (rule synthetic-b7b5a539767d): they appear in one hard cut, complete (synthetic-9710181698cd), do not move or animate while up, and clear in one hard cut.

    {"type": "word_behind", "id": "q", "font": "display_heavy", "blocks": [{"text": "I LOVE", "size": 250, "pos": [x, y], "rot": -1}, ...],
     "at": s, "out": s, "matte": "work-round-8/matte/<id>/matte", "sound": "ch2_in", "out_sound": "ch2_out"}

`matte` is a folder (relative to the request's root) of one 8-bit png per overlay frame, 0000.png at the overlay's first frame; 255 = speaker."""
import os

import sys

import numpy as np
from PIL import Image, ImageDraw
from overlay import kit, look, stage

from overlay.helpers.sound_classes import play
from overlay.helpers import paper_pieces as K
FPS = 24000 / 1001


def paper_block(text, size, fnt, seed):
    """One paper-word block as in the row (F-0267 frames): white paper with its texture, heavy black capitals with a small offset dark edge."""
    pad = int(size * 0.2)
    tw = int(fnt.getlength(text))
    asc, desc = fnt.getmetrics()
    w, h = tw + 2 * pad, int((asc + desc) * 0.86) + 2 * pad
    im = K.paper(w, h, 'white', seed, edge='straight')
    d = ImageDraw.Draw(im)
    off = max(3, size // 45)
    d.text((pad + off, pad + off - int(size * 0.12)), text, font=fnt, fill=(70, 70, 70, 255))
    d.text((pad, pad - int(size * 0.12)), text, font=fnt, fill=(12, 12, 12, 255))
    return im


def ev_word_behind(self, e):
    sid = e.get('id', 'behind')
    fnt_cache = {}
    canvas = Image.new('RGBA', (stage.W, stage.H), (0, 0, 0, 0))
    boxes = []
    for i, blk in enumerate(e['blocks']):
        size = blk['size']
        fnt = fnt_cache.setdefault(size, kit.sf(e.get('font', 'display_heavy'), size))
        im = paper_block(blk['text'], size, fnt, 11 + i)
        if blk.get('rot'):
            im = im.rotate(-blk['rot'], expand=True, resample=Image.BICUBIC)
        sh, spad = stage.shadowed(im, {'dx': 4, 'dy': 8, 'blur': 14, 'opacity': 0.35})
        x, y = blk['pos']
        canvas.alpha_composite(sh, (int(x - spad), int(y - spad)))
        boxes.append((x, y, x + im.width, y + im.height))
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    right, bottom = max(b[2] for b in boxes), max(b[3] for b in boxes)
    self.safe_box(sid, x0, y0, right, bottom, self.T(e['at']), self.T(e['out']))
    base_a = np.asarray(canvas.getchannel('A'), dtype=np.float32)
    rgb = np.asarray(canvas.convert('RGB'))
    mdir = look.at_root(e['matte'])
    t_in, t_out, t0 = self.T(e['at']), self.T(e['out']), self.T(0)
    cache = {}

    def dyn(tt):
        if not (t_in <= tt < t_out):
            return None, 0, 0
        n = int(round((tt - t0) * FPS))
        if n not in cache:
            m = np.asarray(Image.open(os.path.join(mdir, '%04d.png' % n)).convert('L'), dtype=np.float32) / 255.0
            m = np.clip((m - 0.12) / 0.3, 0.0, 1.0)   # a firm edge: the soft matte left the glossy tub lid and the arm half see-through
            a = (base_a * (1.0 - m)).astype(np.uint8)
            out = np.dstack([rgb, a])
            cache[n] = Image.fromarray(out, 'RGBA')
        return cache[n], 0, 0
    sp = stage.Sprite(sid, None, 0, 0, t_in, 'none', 0, order=e.get('order', 60), jitter=False)
    sp.dynamic = dyn
    self.add(sp)
    # declared for film-qa (settle, dwell): this layer has a hole where the speaker stands, so its alpha mass and centroid move with him; the unmasked
    # shape is the words alone. `occluded_by` names what cuts the hole and `matte` the folder of per-frame mattes (relative to the request's root).
    note = {'occluded_by': 'person_matte', 'matte': e['matte']}
    entry = next((x for x in self.log if x.get('id') == sid), None)
    if entry is None:
        entry = {'id': sid, 'at': round(t_in, 3)}
        self.log.append(entry)
    entry.update(note)
    if e.get('sound'):
        play(self, e['sound'], t_in)
    if e.get('out_sound'):   # the words leave on a hard cut and carry their own exit sound (a different one from the entry)
        play(self, e['out_sound'], t_out)
