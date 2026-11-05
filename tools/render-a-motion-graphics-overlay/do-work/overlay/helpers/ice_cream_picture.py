"""Helper for lane ch2 (not an event): a scoop of ice cream on a waffle cone, drawn by code with light and texture, so
particles can take their colour and shading from a real-looking picture (round 2, 6:21: the person asked for coloured dots,
far more of them, a cone, shadows and the scoop's colour). render(w, h) -> RGBA uint8 array, h x w.

Built as real 3D shapes and lit, drawn at 2x and reduced (anti-aliased):
- the scoop is a union of spheres: one main ball, a rolled lip of small balls where it was pressed onto the cone, and
  drips; each pixel takes the nearest surface, so lumps shade and shadow each other;
- caramel cream with two glossy fudge ribbons (the colours of his own tray at 6:30), a fine frozen grain;
- key light upper left, fill, a cool rim on the right, ambient occlusion in the creases, a soft cast shadow on the cone;
- the cone is golden waffle: a cylinder-shaded triangle with a diagonal grid of raised ridges, darker pockets, a rim band."""
import numpy as np


def _noise(h, w, scale, seed):
    """Smooth value noise in [0, 1]."""
    rng = np.random.default_rng(seed)
    gh, gw = int(h / scale) + 3, int(w / scale) + 3
    g = rng.random((gh, gw))
    ys, xs = np.linspace(0, gh - 3, h), np.linspace(0, gw - 3, w)
    y0, x0 = ys.astype(int), xs.astype(int)
    fy, fx = ys - y0, xs - x0
    fy, fx = fy * fy * (3 - 2 * fy), fx * fx * (3 - 2 * fx)
    a, b, c, d = g[y0][:, x0], g[y0][:, x0 + 1], g[y0 + 1][:, x0], g[y0 + 1][:, x0 + 1]
    top = a + (b - a) * fx[None, :]
    bot = c + (d - c) * fx[None, :]
    return top + (bot - top) * fy[:, None]


def _norm(v):
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def render(w, h, seed=3):
    S = 2
    W, H = w * S, h * S
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    rgb = np.zeros((H, W, 3), np.float32)
    alpha = np.zeros((H, W), np.float32)
    key = _norm(np.array([-0.5, -0.65, 0.58]))
    rim_dir = _norm(np.array([0.85, -0.1, 0.3]))
    cx = W / 2

    # ---------------- cone
    top_y, apex_y, half_top = H * 0.47, H * 0.99, W * 0.31
    v = (yy - top_y) / (apex_y - top_y)
    half = half_top * (1 - v)
    cone = (v >= 0) & (v <= 1) & (np.abs(xx - cx) <= half)
    s = np.clip((xx - cx) / np.maximum(half, 1), -1, 1)
    nz = np.sqrt(1 - s * s)
    shade = 0.28 + 0.82 * np.clip(nz * 0.85 - s * 0.4, 0, 1.1)
    p = 25.0 * S
    u1 = ((xx - cx) * 0.8 + (yy - top_y)) / p
    u2 = (-(xx - cx) * 0.8 + (yy - top_y)) / p
    f1, f2 = u1 - np.floor(u1), u2 - np.floor(u2)
    ridge = np.maximum(np.exp(-((f1 - 0.5) ** 2) / 0.008), np.exp(-((f2 - 0.5) ** 2) / 0.008))
    lit_edge = np.maximum(np.exp(-((f1 - 0.44) ** 2) / 0.004), np.exp(-((f2 - 0.44) ** 2) / 0.004)) * 0.25
    gold, pocket = np.array([0.86, 0.60, 0.29]), np.array([0.52, 0.31, 0.12])
    c = pocket + (gold - pocket) * (0.25 + 0.75 * ridge[..., None]) + lit_edge[..., None]
    c *= (0.92 + 0.16 * _noise(H, W, 4 * S, seed + 1))[..., None] * shade[..., None]
    band = cone & (yy < top_y + H * 0.045)
    c = np.where(band[..., None], c * 0.82, c)
    rgb[cone], alpha[cone] = c[cone], 1.0

    # ---------------- scoop: rounded solids (segment a-b with radius r; a ball when a == b), nearest surface wins
    R = W * 0.37
    cy0 = top_y - R * 0.80
    rng = np.random.default_rng(seed)
    solids = [((cx, cy0), (cx, cy0), R, 0.0)]
    for k in range(15):  # the rolled lip pressed onto the cone: uneven overlapping lumps, bigger at the sides
        t = -1 + 2 * k / 14 + rng.uniform(-0.04, 0.04)
        y = top_y - R * 0.06 + rng.uniform(-0.06, 0.04) * R - R * 0.10 * (1 - t * t)
        rr = R * (0.17 + 0.07 * abs(t)) * rng.uniform(0.85, 1.15)
        solids.append(((cx + t * half_top * 1.04, y), (cx + t * half_top * 1.04, y), rr, R * (0.50 + 0.12 * (1 - t * t))))
    for fx, ln, rr in [(-0.58, 0.21, 0.105), (-0.10, 0.11, 0.085), (0.36, 0.27, 0.11), (0.72, 0.14, 0.085)]:  # drips
        x = cx + fx * half_top * (1 - 0.15 * ln)
        solids.append(((x, top_y - R * 0.04), (x, top_y + R * ln), R * rr, R * 0.62))
    z = np.full((H, W), -1.0, np.float32)
    nx = np.zeros((H, W), np.float32)
    ny = np.zeros((H, W), np.float32)
    nzz = np.zeros((H, W), np.float32)
    owner = np.full((H, W), -1, np.int16)
    for i, ((ax_, ay_), (bx_, by_), br, lift) in enumerate(solids):
        sx, sy = bx_ - ax_, by_ - ay_
        L2 = sx * sx + sy * sy
        tq = np.clip(((xx - ax_) * sx + (yy - ay_) * sy) / L2, 0, 1) if L2 > 0 else 0.0
        qx, qy = ax_ + tq * sx, ay_ + tq * sy
        rr = br * (1 - 0.45 * tq) if L2 > 0 else br  # drips taper from the lip to a round tip
        d2 = (xx - qx) ** 2 + (yy - qy) ** 2
        inside = d2 < rr * rr
        h0 = np.sqrt(np.maximum(rr * rr - d2, 0))
        zz = np.where(inside, h0 + lift, -1)
        win = zz > z
        z = np.where(win, zz, z)
        nx = np.where(win, (xx - qx) / rr, nx)
        ny = np.where(win, (yy - qy) / rr, ny)
        nzz = np.where(win, h0 / rr, nzz)
        owner = np.where(win, i, owner)
    scoop = owner >= 0
    grain = _noise(H, W, 3 * S, seed + 5)
    lumps = _noise(H, W, 22 * S, seed + 6)
    gy, gx = np.gradient(lumps * 1.0 + grain * 0.04)
    bumpk = np.where(owner == 0, 2.0, 0.6)  # small lumps get less surface texture, or it reads as ribbing
    N = _norm(np.stack([nx - gx * bumpk, ny - gy * bumpk, nzz + 0.12], -1))
    lam = np.clip((N * key).sum(-1), 0, 1)
    half_v = _norm(key + np.array([0, 0, 1]))
    spec = np.clip((N * half_v).sum(-1), 0, 1)
    rimv = np.clip((N * rim_dir).sum(-1), 0, 1) ** 4 * (1 - nzz) ** 0.5
    # fudge ribbons: two bands that wrap round the ball (in its own surface coordinates), warped by the lumps
    phi = np.arctan2(nx, np.maximum(nzz, 1e-3))
    rib = np.clip(1 - np.abs(np.sin(phi * 1.4 + ny * 1.9 + (lumps - 0.5) * 0.5)) * 1.5, 0, 1) * (owner == 0)
    cream, fudge = np.array([0.90, 0.74, 0.54]), np.array([0.33, 0.18, 0.09])
    base = cream * (1 - rib[..., None]) + fudge * rib[..., None]
    base *= (0.96 + 0.06 * grain)[..., None]
    # ambient occlusion: crease between the main ball and the lip, and the lower half
    ao = np.ones((H, W), np.float32)
    ao = np.where(owner > 0, 0.9, ao)
    crease = np.exp(-((yy - (top_y - R * 0.12)) ** 2) / (2 * (R * 0.07) ** 2)) * (owner == 0)
    ao *= 1 - 0.35 * crease
    light = (0.30 + 0.78 * lam) * ao + rimv * 0.35
    col = base * light[..., None] + (spec ** 40 * (0.28 + 0.4 * rib))[..., None] + (spec ** 8 * 0.06)[..., None]
    rgb[scoop], alpha[scoop] = col[scoop], 1.0
    # cast shadow of the scoop on the cone just under the lip
    sh = cone & ~scoop & (yy > top_y) & (yy < top_y + R * 0.5)
    k = np.clip(1 - (yy - top_y) / (R * 0.5), 0, 1)[..., None]
    rgb = np.where(sh[..., None], rgb * (1 - 0.5 * k), rgb)

    out = np.concatenate([np.clip(rgb, 0, 1), alpha[..., None]], -1)
    out = out.reshape(h, S, w, S, 4).mean((1, 3))
    out[..., :3] = np.where(out[..., 3:4] > 0, out[..., :3] / np.maximum(out[..., 3:4], 1e-3), 0)  # un-premultiply the edge
    return (np.clip(out, 0, 1) * 255).astype(np.uint8)


if __name__ == '__main__':
    import sys
    from PIL import Image
    Image.fromarray(render(int(sys.argv[1]), int(sys.argv[2])), 'RGBA').save(sys.argv[3])
