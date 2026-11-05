"""Lane ch3 helpers for the peptide explainers (peptide_takeover, proglucagon_cut): amino-acid beads drawn as lit spheres with
the residue's one-letter code, a dark editorial plate, and text that rises into place.

bead(r, letter, colour)          a shaded sphere (key light top left, rim light, soft contact shade) with its letter in white
plate(w, h, seed)                the dark explainer ground: a soft radial lift in the middle and fine static grain
rise(img, u)                     text arriving: fades in while rising 14 px, eased (u 0..1); returns (img, dy)
pop(u)                           a bead's scale while it pops on (0 -> 1.12 -> 1 over u 0..1)
"""
import math
import numpy as np
from PIL import Image, ImageDraw
from overlay import kit
from overlay.helpers import paper_pieces as K

AMBER = (255, 178, 74)
GREY = (120, 128, 140)
INK_BG = (15, 18, 24)


def bead(r, letter=None, colour=AMBER, letter_px=None):
    S = 3
    R = r * S
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1].astype(np.float32) / R
    d2 = xx * xx + yy * yy
    inside = d2 <= 1.0
    z = np.sqrt(np.clip(1 - d2, 0, 1))
    lx, ly, lz = -0.45, -0.55, 0.7  # key light from the top left, toward the viewer
    n = math.sqrt(lx * lx + ly * ly + lz * lz)
    lam = np.clip((xx * lx + yy * ly + z * lz) / n, 0, 1)
    rim = np.clip(1 - z, 0, 1) ** 3 * np.clip(xx * 0.6 + yy * 0.8, 0, 1)  # cool rim from the bottom right
    spec = np.clip((xx * lx + yy * ly + z * lz) / n, 0, 1) ** 40
    c = np.array(colour, np.float32)
    rgb = c[None, None, :] * (0.32 + 0.78 * lam[..., None]) + 255 * 0.55 * spec[..., None] + np.array([90, 120, 170]) * 0.5 * rim[..., None]
    edge = np.clip((1 - np.sqrt(d2)) * R / 1.5, 0, 1)  # antialiased silhouette
    out = np.dstack([np.clip(rgb, 0, 255), 255 * edge * inside]).astype(np.uint8)
    im = Image.fromarray(out, 'RGBA').resize((2 * r + 1, 2 * r + 1), Image.LANCZOS)
    if letter:
        fnt = kit.sf('display_bold', letter_px or int(r * 1.05))
        ImageDraw.Draw(im).text((r + 0.5, r + 1), letter, font=fnt, fill=(255, 255, 255, 235), anchor='mm')
    return im


def plate(w, h, seed=7):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((xx - w * 0.5) / (w * 0.75)) ** 2 + ((yy - h * 0.45) / (h * 0.8)) ** 2)
    lift = np.clip(1 - d, 0, 1) ** 1.5
    base = np.array(INK_BG, np.float32)[None, None, :] + np.array([16, 18, 24], np.float32)[None, None, :] * lift[..., None]
    grain = np.random.default_rng(seed).normal(0, 2.2, (h, w, 1)).astype(np.float32)
    rgb = np.clip(base + grain, 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, np.full((h, w), 255, np.uint8)]), 'RGBA')


def rise(img, u):
    u = min(max(u, 0.0), 1.0)
    if u >= 1:
        return img, 0
    e = K.ease_out(u)
    out = img.copy()
    out.putalpha(out.getchannel('A').point(lambda v: int(v * e)))
    return out, int(round(14 * (1 - e)))


def pop(u):
    u = min(max(u, 0.0), 1.0)
    if u < 0.6:
        return 1.12 * K.ease_out(u / 0.6)
    return 1.12 - 0.12 * K.ease_out((u - 0.6) / 0.4)


def text(s, kind, px, colour=(255, 255, 255)):
    return kit.text_img(s, kit.sf(kind, px), colour, shadow=False)[0]
