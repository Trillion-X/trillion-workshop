"""scoop_form (lane ch2, round 2): thousands of coloured particles drift loose on one word, then fly together into a real-
looking scoop of ice cream on a waffle cone, each landing on the pixel whose colour it carries, and the picture resolves
solid (light, shadow, waffle) as the last ones land; on the exit word it slides out of frame in one piece. The person, round 1: "the dots could've been colours ... way more dots ... a cone and shadows and the colour of the
scoop". Technique: particle image reveal (each particle samples the target image's colour; gongnyang/awesome-ai-motion
#507), form-to-shape (Trapcode Form / three.js morph targets: a start field and a target field, eased per particle with a
staggered delay), motion blur as per-particle streaks over 1.5 frames (styles on 1s; cth9191/animate). Engine:
events/_ch2_particles.py; picture: events/_ch2_icecream.py. filmcraft/options-ch2/techniques/scoop-form.md.

    {"type": "scoop_form", "id": "scoop", "n": 5200, "seed": 11, "box": [x0, y0, x1, y1],       picture box (the cone)
     "cloud": [x0, y0, x1, y1],                                                             where the loose particles drift
     "at": s, "assemble_at": s, "assemble_s": 0.8, "out": s, "out_dir": "E",
     "masked_within": "scoop", "window": [x0, y0, x1, y1]}                   film-qa: particles join and split inside it
"""
import math
import numpy as np
from overlay.helpers.ice_cream_picture import render as ice_cream
from overlay.helpers.particles_to_picture import form, targets
from overlay.helpers.sound_classes import play


def ev_scoop_form(self, e):
    sid = e.get('id', 'scoop')
    rng = np.random.default_rng(e.get('seed', 11))
    n = e.get('n', 5200)
    bx0, by0, bx1, by1 = e['box']
    pic = ice_cream(int(bx1 - bx0), int(by1 - by0), seed=e.get('pic_seed', 3))
    tx, ty, col = targets(pic, e['box'], n, rng)
    cx0, cy0, cx1, cy1 = e['cloud']
    ang = rng.uniform(0, 2 * math.pi, n)  # the loose field: a soft disc of motes, denser in the middle
    rad = np.sqrt(rng.uniform(0, 1, n))
    px = (cx0 + cx1) / 2 + np.cos(ang) * rad * (cx1 - cx0) / 2
    py = (cy0 + cy1) / 2 + np.sin(ang) * rad * (cy1 - cy0) / 2
    ph = rng.uniform(0, 2 * math.pi, (n, 3))
    appear = rng.uniform(0, 0.5, n)
    t_in = self.T(e['at'])

    def loose_xy(tt):  # each mote drifts on its own slow orbit (a flow, not a jitter)
        dt = tt - t_in
        return (px + 22 * np.sin(0.8 * dt + ph[:, 0]) + 9 * np.sin(1.9 * dt + ph[:, 2]),
                py + 16 * np.sin(0.6 * dt + ph[:, 1]) + 7 * np.cos(1.7 * dt + ph[:, 2]))

    def loose_alpha(tt):  # motes fade up one by one, and stay faint, so the field reads as dust, not a disc
        return np.clip((tt - t_in - appear) / 0.25, 0, 1) * 0.55

    self.safe_box(sid, min(bx0, cx0), min(by0, cy0), max(bx1, cx1), max(by1, cy1), t_in, self.T(e['out']))
    t_solid = form(self, sid, e, pic, tx, ty, col, loose_xy, col * 0.55 + 255 * 0.45, loose_alpha,
                   rng.uniform(1.6, 2.6, n), rng)
    play(self, 'ch2_in', t_in)
    play(self, 'ch2_shimmer', self.T(e['assemble_at']))  # one designed sound for the whole gather
    play(self, 'ch2_lock', t_solid - 0.05)
    play(self, 'ch2_out', self.T(e['out']))
