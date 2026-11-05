"""archive_panels (lane ch5): his own old vertical phone videos shown full frame in a horizontal film, the way documentaries and
news edits carry vertical footage (technique: archive panels; library/techniques/archive-panels.md). The frame is the same
footage again, scaled to fill, blurred and darkened (the standard "blurred fill" for vertical video), and the sharp clips sit
on it as rounded panels with a soft shadow. One panel holds one clip; several panels play side by side so a few seconds show
years of work (split screen). Cut in and out on the frame grid, no fade: it is a cutaway (covers_a_roll).

    {"type": "archive_panels", "id": "crepes", "covers_a_roll": true, "at": s, "until": s,
     "fill": {"src": clip.mp4, "start": 0.0, "darken": 0.45, "blur": 28},   darken < 0 lifts a dark fill
     "panels": [{"src": clip.mp4, "start": 0.0, "box": [x, y, w, h], "delay": 0.0}, ...],
     "enter": "rise" | "none", "enter_s": 0.32}

Every clip is read at the film's frame rate (ClipReader) from a file already cut, cropped clear of any watermark and graded
(options-ch5/tools/r2/m03_tools/prep_clips.py). With "rise" each panel comes up 340 px into its place, fading up over the first 40% of the rise, eased,
`delay` seconds after the cutaway starts, with motion blur along its travel (synthetic-4015c76f9424: smooth move, real
footage); the fill is there from the first frame. Sound: the option names one sound for the panels' arrival
(`sound`: kind), none when the panels are simply there."""
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from overlay import stage
from overlay.kit import ClipReader, SmoothSprite, ease_out
from overlay.stage import FPS

from overlay.helpers.motion_smear import FRAME_S, smear


def over(dst, img, x, y):
    """alpha_composite img onto dst at (x, y), clipped to dst (paste with a mask would blend dst's own alpha too)."""
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(dst.width, x + img.width), min(dst.height, y + img.height)
    if x1 > x0 and y1 > y0:
        dst.alpha_composite(img.crop((x0 - x, y0 - y, x1 - x, y1 - y)), (x0, y0))


def rounded(img, r):
    m = Image.new('L', img.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius=r, fill=255)
    out = img.convert('RGBA')
    out.putalpha(m)
    return out


RISE_PX = 340  # how far below its place a rising panel starts


def ev_archive_panels(self, e):
    sid = e.get('id', 'archive')
    na, nu = round(self.T(e['at']) * FPS), round(self.T(e['until']) * FPS)
    t0 = na / FPS
    f = e['fill']
    small = (stage.W // 6, stage.H // 6)  # the fill is read small and blurred: cheap, and no detail is wanted there
    fill = ClipReader(f['src'], f.get('start', 0.0), small)
    darken, blur = f.get('darken', 0.45), f.get('blur', 28)
    radius = e.get('radius', 26)
    enter, enter_s = e.get('enter', 'none'), e.get('enter_s', 0.32)
    panels = [(ClipReader(p['src'], p.get('start', 0.0), (p['box'][2], p['box'][3])), p) for p in e['panels']]
    shadow_cache = {}

    def shadow_of(w, h):
        if (w, h) not in shadow_cache:
            pad = 40
            s = Image.new('L', (w + 2 * pad, h + 2 * pad), 0)
            ImageDraw.Draw(s).rounded_rectangle([pad, pad + 10, pad + w, pad + h + 10], radius=radius, fill=150)
            shadow_cache[(w, h)] = (s.filter(ImageFilter.GaussianBlur(18)), pad)
        return shadow_cache[(w, h)]

    def rise(p, tt):
        """The panel's offset below its place at time tt (0 once it has landed)."""
        if enter != 'rise':
            return 0.0
        u = (tt - t0 - p.get('delay', 0.0)) / enter_s
        if u >= 1:
            return 0.0
        return RISE_PX * (1 - ease_out(max(0.0, u)))

    def opacity(p, tt):
        """A rising panel fades up over the first 40% of its rise, so the cutaway shows footage from its first frame."""
        if enter != 'rise':
            return 1.0
        return min(1.0, max(0.0, (tt - t0 - p.get('delay', 0.0)) / (0.4 * enter_s)))

    def frame(tt):
        n = round(self.t_exact * FPS)
        if n >= nu or n < na:
            return None, 0, 0
        k = n - na
        bg = fill.get(k).resize((stage.W, stage.H), Image.BILINEAR)
        bg = Image.fromarray(cv2.GaussianBlur(np.asarray(bg), (0, 0), blur * stage.W / 1920 / 2)).point(lambda v: min(255, int(v * (1 - darken))))
        out = bg.convert('RGBA')
        for rd, p in panels:
            x, y, w, h = p['box']
            dy = rise(p, self.t_exact)
            img = rounded(rd.get(k), radius)
            op = opacity(p, self.t_exact)
            if op < 1:
                img.putalpha(img.getchannel('A').point(lambda v, op=op: int(v * op)))
            sh, pad = shadow_of(w, h)
            black = Image.new('RGBA', sh.size, (0, 0, 0, 0))
            black.putalpha(sh if op >= 1 else sh.point(lambda v, op=op: int(v * op)))
            over(out, black, int(x - pad), int(y + dy - pad))
            prev = rise(p, self.t_exact - FRAME_S)
            if abs(prev - dy) >= 3:
                img, px, py = smear(img, x, y + dy, 0, dy - prev)
            else:
                px, py = x, y + dy
            over(out, img, int(round(px)), int(round(py)))
        return out, 0, 0

    sp = SmoothSprite(self, sid, None, 0, 0, (na - 0.25) / FPS, 'none', 0, order=1, jitter=False)
    sp.dynamic = frame
    self.add(sp)
    if e.get('sound'):
        self.sound(e['sound'], t0)
