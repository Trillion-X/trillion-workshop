"""molecule_scoop (lane ch2, round 2): real molecules, then ice cream. On "molecular" three real molecules (their true 3D
shapes from PubChem: a sugar, a fat, an amino acid) pop in as ball-and-stick models in CPK colours and turn slowly in 3D;
on the gather word each atom breaks into a stream of particles that fly into a lit scoop of ice cream on a waffle cone,
taking the colour of the pixel they land on, and the picture resolves solid; on the exit word it slides out of frame.
It says the line literally: what is in it, broken down to the molecular level, put back together in the form of ice cream.

Techniques: ball-and-stick molecular models in CPK colours, rotated and depth-sorted (as in molecular-biology animation:
PDB-101, Kurzgesagt-style molecules); form-to-shape particle morph (Trapcode Form, three.js morph targets); particle image
reveal (gongnyang #507). Engine: events/_ch2_particles.py; picture: events/_ch2_icecream.py. Molecule data: the SDF files'
own coordinates (filmcraft/options-ch2/assets/r2-m10/PROVENANCE.json).

    {"type": "molecule_scoop", "id": "mol", "n": 4200, "seed": 5, "box": [x0, y0, x1, y1],               the cone
     "molecules": [{"sdf": path, "center": [x, y], "scale": px_per_angstrom, "tilt": deg}],
     "at": s, "stagger_s": 0.16, "assemble_at": s, "assemble_s": 0.8, "out": s, "out_dir": "W",
     "masked_within": "mol", "window": [x0, y0, x1, y1]}
"""
import math
import numpy as np
from PIL import Image, ImageDraw
from overlay import kit, look, stage
from overlay.kit import SmoothSprite, ease_out
from overlay.helpers.ice_cream_picture import render as ice_cream
from overlay.helpers.particles_to_picture import form, targets
from overlay.helpers.sound_classes import play
CPK = {'C': (70, 72, 78), 'O': (226, 52, 44), 'H': (238, 238, 240), 'N': (58, 96, 228)}
RAD = {'C': 0.40, 'O': 0.38, 'H': 0.24, 'N': 0.38}  # angstroms, ball-and-stick


def _sdf(path):
    lines = open(path).read().split('\n')
    na, nb = int(lines[3][:3]), int(lines[3][3:6])
    atoms = []
    for l in lines[4:4 + na]:
        p = l.split()
        atoms.append((float(p[0]), float(p[1]), float(p[2]), p[3]))
    bonds = [(int(l[:3]) - 1, int(l[3:6]) - 1, int(l[6:9])) for l in lines[4 + na:4 + na + nb]]
    xyz = np.array([a[:3] for a in atoms])
    xyz -= xyz.mean(0)
    return xyz, [a[3] for a in atoms], bonds


def _ball(r, rgb):
    """A shaded sphere sprite (radial light from the upper left), 2r + 4 square."""
    s = int(2 * r + 4)
    yy, xx = np.mgrid[0:s, 0:s].astype(np.float32)
    dx, dy = (xx - s / 2) / r, (yy - s / 2) / r
    d2 = dx * dx + dy * dy
    nz = np.sqrt(np.clip(1 - d2, 0, 1))
    lam = np.clip(-0.45 * dx - 0.55 * dy + 0.7 * nz, 0, 1)
    spec = np.clip(-0.45 * dx - 0.55 * dy + 0.7 * nz, 0, 1) ** 30
    c = np.array(rgb, np.float32)[None, None, :] / 255 * (0.32 + 0.8 * lam[..., None]) + spec[..., None] * 0.5
    a = np.clip((1 - np.sqrt(d2)) * r, 0, 1)
    out = np.concatenate([np.clip(c, 0, 1), a[..., None]], -1)
    return Image.fromarray((out * 255).astype(np.uint8), 'RGBA')


def ev_molecule_scoop(self, e):
    sid = e.get('id', 'mol')
    rng = np.random.default_rng(e.get('seed', 5))
    t_in, t_as, t_out = self.T(e['at']), self.T(e['assemble_at']), self.T(e['out'])
    mols = []
    for k, m in enumerate(e['molecules']):
        xyz, el, bonds = _sdf(m['sdf'])
        mols.append({'xyz': xyz, 'el': el, 'bonds': bonds, 'c': m['center'], 'sc': m['scale'], 'tilt': math.radians(m.get('tilt', 20)),
                     'spin': 0.55 * (1 if k % 2 == 0 else -1), 'phase': 1.3 * k, 't': t_in + k * e.get('stagger_s', 0.16),
                     'balls': {a: _ball(RAD[a] * m['scale'], CPK[a]) for a in set(el)}})

    def project(m, tt):
        """Screen x, y and depth of every atom of molecule m at tt (spinning about the vertical axis, tilted)."""
        a = m['phase'] + m['spin'] * (tt - t_in)
        x, y, z = m['xyz'][:, 0], m['xyz'][:, 1], m['xyz'][:, 2]
        x1, z1 = x * math.cos(a) + z * math.sin(a), -x * math.sin(a) + z * math.cos(a)
        y1, z2 = y * math.cos(m['tilt']) - z1 * math.sin(m['tilt']), y * math.sin(m['tilt']) + z1 * math.cos(m['tilt'])
        pop = ease_out(min(1.0, max(0.0, (tt - m['t']) / 0.3)))
        s = m['sc'] * (0.75 + 0.25 * pop)
        return m['c'][0] + x1 * s, m['c'][1] + y1 * s, z2, pop

    # the particles: each one starts inside an atom, in that atom's colour
    bx0, by0, bx1, by1 = e['box']
    pic = ice_cream(int(bx1 - bx0), int(by1 - by0), seed=e.get('pic_seed', 3))
    n = e.get('n', 4200)
    tx, ty, col = targets(pic, e['box'], n, rng)
    owner = [(mi, ai) for mi, m in enumerate(mols) for ai in range(len(m['el']))]
    pick = rng.integers(0, len(owner), n)
    own_m = np.array([owner[p][0] for p in pick])
    own_a = np.array([owner[p][1] for p in pick])
    rad_px = np.array([RAD[mols[mi]['el'][ai]] * mols[mi]['sc'] for mi, ai in zip(own_m, own_a)])
    off = rng.normal(0, 0.45, (n, 2)) * rad_px[:, None]
    loose_col = np.array([CPK[mols[mi]['el'][ai]] for mi, ai in zip(own_m, own_a)], np.float32)

    def loose_xy(tt):
        x, y = np.zeros(n), np.zeros(n)
        for mi, m in enumerate(mols):
            px, py, _, _ = project(m, tt)
            sel = own_m == mi
            x[sel], y[sel] = px[own_a[sel]], py[own_a[sel]]
        return x + off[:, 0], y + off[:, 1]

    def loose_alpha(tt):  # hidden while the models are drawn; they take over the instant the atoms break up
        return np.full(n, 1.0 if tt >= t_as else 0.0)

    def models(tt):
        if tt < t_in:
            return None, 0, 0
        fade = 1 - min(1.0, max(0.0, (tt - t_as) / 0.1))
        if fade <= 0:
            return None, 0, 0
        layer = Image.new('RGBA', (stage.W, stage.H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        for m in mols:
            if tt < m['t']:
                continue
            x, y, z, pop = project(m, tt)
            items = [('b', (z[i] + z[j]) / 2, i, j, o) for i, j, o in m['bonds']] + [('a', z[i], i, 0, 0) for i in range(len(z))]
            for kind, _, i, j, o in sorted(items, key=lambda q: q[1]):  # far to near
                if kind == 'b':
                    mx, my = (x[i] + x[j]) / 2, (y[i] + y[j]) / 2
                    w = int(m['sc'] * 0.16) + (2 if o > 1 else 0)
                    for (ax, ay, el) in ((x[i], y[i], m['el'][i]), (x[j], y[j], m['el'][j])):
                        c = tuple(int(v * 0.85) for v in CPK[el]) + (int(255 * pop),)
                        d.line([(ax, ay), (mx, my)], fill=c, width=w)
                else:
                    b = m['balls'][m['el'][i]]
                    if pop < 1:
                        b = b.copy()
                        b.putalpha(b.getchannel('A').point(lambda v: int(v * pop)))
                    layer.alpha_composite(b, (int(x[i] - b.width / 2), int(y[i] - b.height / 2)))
        if fade < 1:
            layer.putalpha(layer.getchannel('A').point(lambda v: int(v * fade)))
        bbox = layer.getbbox()
        if not bbox:
            return None, 0, 0
        crop = layer.crop(bbox)
        img, p = stage.shadowed(crop, {'dx': 0, 'dy': 6, 'blur': 14, 'opacity': 0.4})
        return img, bbox[0] - p, bbox[1] - p

    sp = SmoothSprite(self, sid + '-models', None, 0, 0, t_in, 'none', 0, order=61, jitter=False)
    sp.dynamic = models
    self.add(sp)
    xs = [m['c'][0] for m in mols]
    ys = [m['c'][1] for m in mols]
    self.safe_box(sid, min(min(xs) - 130, bx0), min(min(ys) - 130, by0), max(max(xs) + 130, bx1), max(max(ys) + 130, by1),
                  t_in, t_out)
    t_solid = form(self, sid, e, pic, tx, ty, col, loose_xy, loose_col, loose_alpha, rng.uniform(1.7, 2.6, n), rng)
    for m in mols:
        play(self, 'ch2_in', m['t'])
    play(self, 'ch2_shimmer', t_as)
    play(self, 'ch2_lock', t_solid - 0.05)
    play(self, 'ch2_out', t_out)
