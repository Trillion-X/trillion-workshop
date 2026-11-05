"""workshop: his workshop as a paper-craft house, seen from the viewer's side. People walk up and knock on its door, and the
byproducts of his experiments pop out of the chimney and the window, one after another, more than the ones he names
(the person's rules show-more-than-he-lists, visuals-real-and-specific).

Built from studied techniques (library video-edit-techniques; PICK-ROUND-2.md, "what I studied"): the pop-up book build
(cb09bcbb: flat paper rises on its hinges, staggered, with a small overshoot), the paper-collage animation on a stop-motion clock
(9009099d: layered paper plates moving on twos, the impact frames held), squash and stretch (3395b3a7: stretch along the flight,
squash on landing, overshoot and settle), and for the morph the shape-morph bridge (de134f4b: the old picture closes onto one
shape, the hole, which becomes its counterpart, the doorway). Paper pieces move on twos with no motion blur
(motion-blur-fits-style); the window shows his own kitchen footage playing every frame (stop-motion-not-on-footage).

Spec: {type: workshop, id, anchor: [cx, ground_y], scale, at, out,      (a panel; morph_from or takeover make the other two)
       build: {at, s},                                  the pop-up build (panel, takeover) or the card-to-house morph (morph)
       morph_from: {sprite, hole: [x, y, r]},           morph: the card sprite (built earlier) it grows out of, and its hole
       window_clip: {src, start, speed, crop},          his footage seen through the window
       walkers: [{at, from_x, stop_x, coat, trousers, skin, hair, h}],
       knocks: [[t, walker index], ...],                each hit of the knuckles (the w_knock recording carries the hits)
       door_open: {at},
       pops: [{at, what: image path | recipe | video, text (recipe lines), w, from: chimney | window, to: [x, y], rot, label,
               to_tk: [x, y] its place during the takeover (without one it is out of shot until the cut back)}],
       takeover: {at, until, scale, anchor}}             the scene fills the frame between these times (hard cuts)
All x/y are px at scale 1 relative to the anchor; between takeover.at and takeover.until the scene is drawn at
takeover.scale about takeover.anchor, over a full-frame paper wall."""
import math
import random

import numpy as np
from PIL import Image, ImageDraw
from overlay import kit
from overlay import stage
from overlay.helpers import marker_and_slide as L

# house geometry at scale 1, in px, origin = bottom centre of the wall
WALL = (460, 300)
ROOF_H, ROOF_OVER = 150, 34
CHIMNEY = (56, 116, 120)          # w, h, centre x from the wall centre
DOOR = (116, 196, -110)           # w, h, centre x
WINDOW = (172, 124, 112, 70)      # w, h, centre x, top from the wall top
STEP_S = 2 / L.FPS                # one stop-motion step (on twos)


def _paper_shape(w, h, kind, seed, poly=None, tint=None, edge=2):
    im = L.paper(w, h, kind, seed, edge_amp=edge, step=7)
    if tint:
        arr = np.asarray(im).astype(np.float32)
        arr[..., :3] *= np.array(tint, np.float32)
        im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), 'RGBA')
    if poly:
        m = Image.new('L', (w, h), 0)
        ImageDraw.Draw(m).polygon(poly, fill=255)
        a = np.minimum(np.asarray(im.getchannel('A')), np.asarray(m))
        im.putalpha(Image.fromarray(a))
    return im


def lines_on(im, segs, colour, width):
    """Pencil lines blended onto a paper piece (drawing straight onto RGBA would overwrite its alpha and punch see-through
    stripes); the piece keeps its own outline."""
    over = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    for seg in segs:
        d.line(seg, fill=colour, width=width)
    a = im.getchannel('A')
    im.alpha_composite(over)
    im.putalpha(a)
    return im


def house_parts(seed):
    """The house as separate paper pieces (wall, roof, chimney, door, window frame), each RGBA at scale 1."""
    ww, wh = WALL
    wall = lines_on(_paper_shape(ww, wh, 'cream', seed), [[(6, y), (ww - 6, y)] for y in range(28, wh, 30)], (176, 162, 136, 150), 2)  # clapboards
    rw = ww + 2 * ROOF_OVER
    roof = _paper_shape(rw, ROOF_H, 'kraft', seed + 1, poly=[(0, ROOF_H), (rw * 0.18, 0), (rw * 0.82, 0), (rw, ROOF_H)], tint=(0.52, 0.48, 0.50))
    rows = [ROOF_H * k / 5 for k in range(1, 5)]
    roof = lines_on(roof, [[(rw * 0.18 * (1 - y / ROOF_H) + 4, y), (rw - rw * 0.18 * (1 - y / ROOF_H) - 4, y)] for y in rows], (40, 36, 38, 120), 2)
    roof = lines_on(roof, [[(rw * 0.18, 2), (rw * 0.82, 2)]], (238, 232, 222, 150), 3)  # the light catching the ridge
    cw, ch, _ = CHIMNEY
    chimney = _paper_shape(cw, ch, 'kraft', seed + 2, tint=(0.80, 0.55, 0.45))
    chimney = lines_on(chimney, [[(3, y), (cw - 3, y)] for y in range(14, ch, 18)], (90, 50, 40, 140), 2)  # brick courses
    dw, dh, _ = DOOR
    door = _paper_shape(dw, dh, 'kraft', seed + 3, poly=[(0, dh), (0, dw / 2), (dw / 2, 0), (dw, dw / 2), (dw, dh)], tint=(0.78, 0.66, 0.56))
    door = lines_on(door, [[(x, dw * 0.25), (x, dh - 4)] for x in (dw * 0.33, dw * 0.66)], (80, 58, 40, 150), 2)  # planks
    dd = ImageDraw.Draw(door)
    dd.ellipse([dw * 0.76, dh * 0.55, dw * 0.76 + 12, dh * 0.55 + 12], fill=(60, 50, 40, 255))  # knob
    xw, xh = WINDOW[0], WINDOW[1]
    frame = Image.new('RGBA', (xw, xh), (0, 0, 0, 0))
    fd = ImageDraw.Draw(frame)
    fd.rectangle([0, 0, xw - 1, xh - 1], outline=(92, 70, 50, 255), width=10)
    fd.line([(xw / 2, 0), (xw / 2, xh)], fill=(92, 70, 50, 255), width=7)
    fd.line([(0, xh / 2), (xw, xh / 2)], fill=(92, 70, 50, 255), width=7)
    gw = ww + 2 * ROOF_OVER + 70
    ground = _paper_shape(gw, 30, 'newsprint', seed + 4, tint=(0.62, 0.74, 0.50), edge=3)  # a torn strip of grass it stands on
    return {'wall': wall, 'roof': roof, 'chimney': chimney, 'door': door, 'frame': frame, 'ground': ground}


WARM_TOP, WARM_LOW = (255, 204, 132), (196, 118, 62)  # his lit kitchen seen through the open door


def doorway(mask):
    """The open doorway: warm light from inside, brighter at the top, with a floor line, cut to the door's shape."""
    w, h = mask.size
    t = np.linspace(0, 1, h)[:, None, None]
    rgb = np.array(WARM_TOP, np.float32) * (1 - t) + np.array(WARM_LOW, np.float32) * t
    arr = np.concatenate([np.broadcast_to(rgb, (h, w, 3)), np.full((h, w, 1), 255, np.float32)], axis=2)
    im = Image.fromarray(arr.astype(np.uint8), 'RGBA')
    ImageDraw.Draw(im).rectangle([0, int(h * 0.86), w, int(h * 0.86) + 3], fill=(120, 70, 36, 255))
    im.putalpha(mask)
    return im


def compose_house(parts, rise, door_open=0.0):
    """The house image (W, H) and its anchor offset; `rise` 0..1 per piece builds it like a pop-up book: the wall stands up
    first, then the roof drops on, then the chimney and door pop in."""
    ww, wh = WALL
    W, H = ww + 2 * ROOF_OVER + 80, wh + ROOF_H + CHIMNEY[1] + 40
    cx, base = W // 2, H - 18
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))

    def hinge(piece, u, x, y_bottom):
        """A piece standing up from its bottom hinge: height scales with u (the paper rotating toward the camera)."""
        if u <= 0:
            return
        u = min(1.0, u)
        h = max(1, int(piece.height * (0.15 + 0.85 * u)))
        p = piece.resize((piece.width, h), Image.BICUBIC)
        if u < 1:  # the far side of the paper is darker while it turns
            arr = np.asarray(p).astype(np.float32)
            arr[..., :3] *= 0.7 + 0.3 * u
            p = Image.fromarray(arr.astype(np.uint8), 'RGBA')
        im.alpha_composite(p, (int(x), int(y_bottom - h)))
    wall_top = base - wh
    hinge(parts['ground'], rise.get('wall', 1), cx - parts['ground'].width / 2, base + 16)
    # the chimney stands behind the roof slope, its top third above the ridge
    hinge(parts['chimney'], rise.get('chimney', 1), cx + CHIMNEY[2] - CHIMNEY[0] / 2, wall_top - ROOF_H + 40)
    hinge(parts['wall'], rise.get('wall', 1), cx - ww / 2, base)
    r = rise.get('roof', 1)
    if r > 0:  # the roof drops onto the wall from above
        drop = (1 - min(1.0, r)) * -60
        im.alpha_composite(parts['roof'], (int(cx - parts['roof'].width / 2), int(wall_top - ROOF_H + 6 + drop)))
    dw, dh, dx = DOOR
    du = rise.get('door', 1)
    if du > 0:
        im.alpha_composite(doorway(parts['door'].getchannel('A')), (int(cx + dx - dw / 2), int(base - dh)))  # behind the door
        door = parts['door']
        if door_open > 0:  # opening: the door narrows on its left hinge
            w2 = max(2, int(dw * (1 - 0.85 * door_open)))
            door = door.resize((w2, dh), Image.BICUBIC)
        hinge(door, du, cx + dx - dw / 2, base)
    return im, (cx, base), wall_top


def figure(pal, pose, h):
    """A paper cut-out person in profile, facing left, about h px tall. pose: {'leg': -1..1 walk phase, 'arm': degrees
    from hanging (positive = raised forward), 'bob': px}."""
    s = h / 200.0
    W, H = int(110 * s), int(215 * s)
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    hip = (W * 0.52, 118 * s - pose.get('bob', 0))
    leg = pose.get('leg', 0)
    for side, sgn in ((0.85, -1), (1.0, 1)):  # far leg darker
        a = sgn * leg * 0.45
        fx, fy = hip[0] + math.sin(a) * 80 * s, hip[1] + math.cos(a) * 80 * s
        col = tuple(int(c * side) for c in pal['trousers'])
        d.line([hip, (fx, fy)], fill=col + (255,), width=int(20 * s))
        d.ellipse([fx - 15 * s, fy - 6 * s, fx + 9 * s, fy + 8 * s], fill=(40, 34, 32, 255))  # shoe pointing left
    # torso: a coat with a slight taper
    tx, ty = hip[0], hip[1]
    d.polygon([(tx - 26 * s, ty + 6 * s), (tx - 20 * s, ty - 72 * s), (tx + 20 * s, ty - 72 * s), (tx + 26 * s, ty + 6 * s)], fill=tuple(pal['coat']) + (255,))
    # head and hair
    hx, hy = tx - 4 * s, ty - 96 * s
    d.ellipse([hx - 21 * s, hy - 23 * s, hx + 21 * s, hy + 23 * s], fill=tuple(pal['skin']) + (255,))
    d.chord([hx - 23 * s, hy - 27 * s, hx + 23 * s, hy + 12 * s], 180, 360, fill=tuple(pal['hair']) + (255,))
    d.ellipse([hx + 4 * s, hy - 8 * s, hx + 24 * s, hy + 16 * s], fill=tuple(pal['hair']) + (255,))  # back of the hair
    d.ellipse([hx - 13 * s, hy - 4 * s, hx - 8 * s, hy + 1 * s], fill=(30, 26, 24, 255))  # eye
    d.ellipse([hx - 25 * s, hy + 1 * s, hx - 17 * s, hy + 9 * s], fill=tuple(int(c * 0.92) for c in pal['skin']) + (255,))  # nose
    # near arm from the shoulder: hanging = pointing down; raised forward toward the left
    sx, sy = tx - 4 * s, ty - 64 * s
    a = math.radians(pose.get('arm', 0))
    ex, ey = sx - math.sin(a) * 66 * s, sy + math.cos(a) * 66 * s
    sleeve = tuple(int(c * 0.88) for c in pal['coat'])
    d.line([(sx, sy), (ex, ey)], fill=sleeve + (255,), width=int(17 * s))
    d.ellipse([ex - 9 * s, ey - 9 * s, ex + 9 * s, ey + 9 * s], fill=tuple(pal['skin']) + (255,))  # fist
    a = im.getchannel('A')  # paper grain over the flat colours, so each figure reads as cut card
    im = stage.apply_texture(im, 'sheet', sum(pal['coat']), 0.45)
    im.putalpha(a)
    return im, (W * 0.5, H)  # anchor: between the feet, on the ground


def recipe_card(seed, lines, w=330):
    """A recipe on a ruled index card in handwriting: lines[0] is the title, the rest the ingredients (the spec's words, so
    the fact gate reads them)."""
    h = int(w * 0.62)
    card = L.paper(w, h, 'index', seed, edge_amp=1, step=10)
    d = ImageDraw.Draw(card)
    d.line([(0, h * 0.24), (w, h * 0.24)], fill=(214, 120, 120, 255), width=2)
    for y in np.arange(h * 0.24 + h * 0.15, h - 6, h * 0.15):
        d.line([(0, y), (w, y)], fill=(176, 194, 216, 255), width=1)
    fh, fb = L.face('Kalam-Bold.ttf', int(w * 0.085)), L.face('Kalam-Bold.ttf', int(w * 0.075))
    ink = (40, 44, 70, 255)
    d.text((w * 0.06, h * 0.2), lines[0], font=fh, fill=ink, anchor='ls')
    for k, line in enumerate(lines[1:]):
        d.text((w * 0.08, h * 0.24 + h * 0.15 * (k + 1) - 5), line, font=fb, fill=ink, anchor='ls')
    return card


def video_card(frame_rgb, w=360):
    """A video of this experiment: a frame of his own footage as a 16:9 thumbnail with a play button and a progress bar."""
    h = int(w * 9 / 16)
    th = frame_rgb.resize((w, h), Image.LANCZOS).convert('RGBA')
    d = ImageDraw.Draw(th)
    r = h * 0.17
    d.ellipse([w / 2 - r, h / 2 - r, w / 2 + r, h / 2 + r], fill=(18, 18, 18, 190))
    d.polygon([(w / 2 - r * 0.35, h / 2 - r * 0.5), (w / 2 - r * 0.35, h / 2 + r * 0.5), (w / 2 + r * 0.55, h / 2)], fill=(255, 255, 255, 255))
    d.rectangle([0, h - 7, w, h], fill=(40, 40, 40, 220))
    d.rectangle([0, h - 7, w * 0.42, h], fill=L.col('accent_red') + (255,))
    border = Image.new('RGBA', (w + 16, h + 16), (250, 250, 248, 255))
    border.alpha_composite(th, (8, 8))
    return border


def tag(text, seed, size=34):
    fnt = L.face('Kalam-Bold.ttf', size)
    tw, th = int(fnt.getlength(text)) + 28, int(size * 1.65)
    t = L.paper(tw, th, 'white', seed, edge_amp=2, step=6)
    ImageDraw.Draw(t).text((tw / 2, th / 2), text, font=fnt, fill=L.col('ink') + (255,), anchor='mm')
    return t


def puff(seed, r):
    """A paper smoke puff: a cluster of torn grey-white circles."""
    rnd = random.Random(seed)
    W = int(r * 2.6)
    im = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    for k in range(5):
        rr = r * rnd.uniform(0.45, 0.75)
        x, y = W / 2 + rnd.uniform(-r * 0.6, r * 0.6), W / 2 + rnd.uniform(-r * 0.4, r * 0.4)
        c = L.paper(int(2 * rr), int(2 * rr), 'newsprint', seed * 7 + k, edge_amp=2, step=5)
        m = Image.new('L', c.size, 0)
        ImageDraw.Draw(m).ellipse([0, 0, c.width - 1, c.height - 1], fill=255)
        c.putalpha(Image.fromarray(np.minimum(np.asarray(c.getchannel('A')), np.asarray(m))))
        im.alpha_composite(c, (int(x - rr), int(y - rr)))
    return im


def _scaled(im, s):
    return im if abs(s - 1) < 1e-3 else im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)


def ev_workshop(self, e):
    S = e.get('scale', 1.0)
    ax, ay = e['anchor']
    t_in, t_out = self.T(e['at']), self.T(e['out'])
    b_at, b_s = self.T(e['build']['at']), e['build'].get('s', 0.9)
    self.seed += 1
    seed = self.seed
    parts = house_parts(seed)
    tk = e.get('takeover')
    tk_in, tk_out = (self.T(tk['at']), self.T(tk['until'])) if tk else (None, None)
    TS = tk.get('scale', 1.9) if tk else 1.0

    def scene_scale(tt):
        return TS if tk and tk_in <= tt < tk_out else S

    def scene_anchor(tt):
        if tk and tk_in <= tt < tk_out:
            return tk.get('anchor', [stage.W / 2 + 120, stage.H - 120])
        return [ax, ay]

    knocks = [(self.T(k[0]), k[1]) for k in e.get('knocks', [])]

    def shake(tt):
        for kt, _ in knocks:
            if 0 <= tt - kt < 3 * STEP_S:
                return ((-3, 1), (2, -1), (-1, 0))[int((tt - kt) / STEP_S)]
        return (0, 0)

    def rise(tt):
        """Each piece's build progress 0..1 (pop-up order: wall, roof, chimney, door), with a small overshoot settle."""
        out = {}
        for k, (name, d0) in enumerate((('wall', 0.0), ('roof', 0.22), ('chimney', 0.42), ('door', 0.5))):
            u = (tt - b_at - d0 * b_s) / (b_s * 0.5)
            out[name] = 0.0 if u <= 0 else (1.0 + 0.08 * math.sin(math.pi * min(1.0, u - 1)) if u >= 1 else L.ease_out(u))
        return out

    open_at = self.T(e['door_open']['at']) if e.get('door_open') else None

    def door_open(tt):
        return 0.0 if open_at is None or tt < open_at else min(1.0, (tt - open_at) / 0.35)

    exit_s = 0.45

    def exit_dx(tt):
        if tt < t_out:
            return 0.0
        v = L.ease_in((tt - t_out) / exit_s)
        return None if v >= 1 else v * (stage.W - ax + WALL[0] * S)

    # the morph: the rabbit-hole card (its last drawn picture) shrinks into the wall while its hole grows into the doorway
    mf = e.get('morph_from')
    card0 = None
    if mf:
        card0 = self.byid(mf['sprite'])[0].dynamic(b_at - 0.01)

    def morph_layer(tt):
        """The card on its way to becoming the wall (u 0..1 over the first 55% of the build), None once it has."""
        if not mf or tt < b_at:
            return None
        u = (tt - b_at) / (b_s * 0.55)
        if u >= 1:
            return None
        u = L.ease_in_out(u, 2.2)
        img, x, y = card0
        w, h = img.size
        tx0, ty0 = ax - WALL[0] * S / 2, ay - WALL[1] * S
        tw_, th_ = WALL[0] * S, WALL[1] * S
        nx, ny = x + (tx0 - x) * u, y + (ty0 - y) * u
        nw, nh = w + (tw_ - w) * u, h + (th_ - h) * u
        im = img.resize((max(2, int(nw)), max(2, int(nh))), Image.BICUBIC)
        if u > 0.5:  # the kraft turns into the wall's cream as it lands
            wall = parts['wall'].resize(im.size, Image.BICUBIC)
            a_ = im.getchannel('A')
            im = Image.blend(im, wall, (u - 0.5) * 2)
            im.putalpha(a_)
        hx, hy, hr = mf['hole']
        dx_, dy_ = ax + DOOR[2] * S, ay - DOOR[1] * S * 0.45
        px, py = hx + (dx_ - hx) * u - nx, hy + (dy_ - hy) * u - ny
        rx = hr + (DOOR[0] * S / 2 - hr) * u
        ry = hr * 0.4 + (DOOR[1] * S / 2 - hr * 0.4) * u
        hole = tuple(int(a + (b - a) * u) for a, b in zip((34, 28, 26), WARM_TOP))  # the dark hole lights up as it becomes the door
        ImageDraw.Draw(im).ellipse([px - rx, py - ry, px + rx, py + ry], fill=hole + (255,))
        return im, nx, ny

    house_cache = {}

    def house_dyn(tt):
        dx = exit_dx(tt)
        if dx is None:
            return None, 0, 0
        m = morph_layer(tt)
        if m is not None:
            return m[0], m[1] + dx, m[2]
        if mf and tt < b_at:
            return None, 0, 0
        r = rise(tt)
        if mf:  # the card has become the wall; the roof, chimney and door pop on after it
            r = dict(rise(tt - b_s * 0.45), wall=1.0)
        key = (tuple(round(v, 2) for v in r.values()), round(door_open(tt), 2))
        if key not in house_cache:
            house_cache[key] = compose_house(parts, r, door_open=door_open(tt))
        im, (cx, base), _ = house_cache[key]
        s = scene_scale(tt)
        an = scene_anchor(tt)
        im2 = _scaled(im, s)
        im2, pad = L.shadow(im2, {'dx': 4, 'dy': 10, 'blur': 18, 'opacity': 0.35})
        sx, sy = shake(tt)
        return im2, an[0] - cx * s - pad + sx + dx, an[1] - base * s - pad + sy

    sp = stage.Sprite(e.get('id', 'shop') + '-house', None, 0, 0, t_in, 'none', 0, order=e.get('order', 54), jitter=False)
    sp.dynamic = house_dyn
    self.add(sp)
    ww, wh = WALL
    box_x0, box_y0 = ax - (ww / 2 + ROOF_OVER) * S, ay - (wh + ROOF_H + CHIMNEY[1]) * S
    if not tk:
        self.safe_box(e.get('id', 'shop') + '-house', box_x0, box_y0, ax + (ww / 2 + ROOF_OVER) * S, ay, t_in, t_out)

    # the window: his own kitchen footage, every frame, framed in the house
    if e.get('window_clip'):
        wc = e['window_clip']
        xw, xh, xcx, xtop = WINDOW
        reader = kit.ClipReader(wc['src'], wc.get('start', 0.0), (int(xw * 2), int(xh * 2)), crop=wc.get('crop'), speed=wc.get('speed', 1.0))
        frame_img = parts['frame']

        def window_dyn(tt):
            dx = exit_dx(tt)
            if dx is None or tt < b_at + b_s * 0.5 + (b_s * 0.45 if mf else 0):
                return None, 0, 0
            s = scene_scale(tt)
            an = scene_anchor(tt)
            fr = reader.get(int(max(0.0, tt - b_at) * L.FPS)).resize((xw, xh), Image.LANCZOS).convert('RGBA')
            warm = Image.new('RGBA', fr.size, (255, 196, 120, 40))
            fr.alpha_composite(warm)
            fr.alpha_composite(frame_img)
            fr = _scaled(fr, s)
            sx, sy = shake(tt)
            return fr, an[0] + (xcx - xw / 2) * s + sx + dx, an[1] - (wh - xtop) * s + sy
        spw = kit.SmoothSprite(self, e.get('id', 'shop') + '-window', None, 0, 0, t_in, 'none', 0, order=e.get('order', 54) + 1, jitter=False)
        spw.dynamic = window_dyn
        self.add(spw)

    # the visitors
    for i, wk in enumerate(e.get('walkers', [])):
        w_at = self.T(wk['at'])
        walk_s = wk.get('walk_s', 1.3)
        pal = {k: wk[k] for k in ('coat', 'trousers', 'skin', 'hair')}
        fh = wk.get('h', 190)
        my_knocks = [kt for kt, who in knocks if who == i]
        fcache = {}

        def walker_dyn(tt, w_at=w_at, walk_s=walk_s, pal=pal, fh=fh, my_knocks=my_knocks, wk=wk, fcache=fcache):
            dx = exit_dx(tt)
            if dx is None or tt < w_at:
                return None, 0, 0
            u = min(1.0, (tt - w_at) / walk_s)
            walking = u < 1
            step_i = int((tt - w_at) / STEP_S)
            leg = math.sin(step_i * math.pi / 2) if walking else 0.0
            bob = abs(leg) * 4
            arm = 8 * leg if walking else 0
            if my_knocks and my_knocks[0] - 2 * STEP_S <= tt < my_knocks[-1] + 3 * STEP_S:  # wind up, hits, recoil
                arm = 72
                if any(0 <= tt - kt < STEP_S for kt in my_knocks):
                    arm = 100
            key = (round(leg, 2), round(arm), round(bob))
            if key not in fcache:
                fcache[key] = L.shadow(figure(pal, {'leg': leg, 'arm': arm, 'bob': bob}, fh)[0], {'dx': 3, 'dy': 6, 'blur': 8, 'opacity': 0.35})
            im, pad = fcache[key]
            s = scene_scale(tt)
            an = scene_anchor(tt)
            x = wk['from_x'] + (wk['stop_x'] - wk['from_x']) * L.ease_out(u)
            im2 = _scaled(im, s)
            return im2, an[0] + x * s - im2.width / 2 + dx, an[1] - (im.height - pad) * s

        spf = stage.Sprite(e.get('id', 'shop') + f'-walker{i}', None, 0, 0, w_at, 'none', 0, order=e.get('order', 54) + 3, jitter=False)
        spf.dynamic = walker_dyn
        self.add(spf)
        self.sound(f'w_step{i % 2 + 1}', w_at + 0.05)
    if knocks:  # one recording of the hits; its first hit sits 0.04 s in (sfx_scan)
        self.sound('w_knock', knocks[0][0] - 0.04)

    # the byproducts: out of the chimney or window on an arc, squash on landing, overshoot and settle
    frame_for_video = None
    for j, pop in enumerate(e.get('pops', [])):
        p_at = self.T(pop['at'])
        if pop['what'] == 'recipe':
            img = recipe_card(seed + 60 + j, pop['text'], pop.get('w', 300))
        elif pop['what'] == 'video':
            if frame_for_video is None:
                fr = kit.ClipReader(pop['src'], pop.get('src_t', 0.0), (640, 360)).get(0)
                frame_for_video = fr
            img = video_card(frame_for_video, pop.get('w', 340))
        else:
            src = Image.open(pop['what']).convert('RGBA')
            src = src.crop(src.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox())  # renders carry empty margins
            img = src.resize((pop.get('w', 200), int(src.height * pop.get('w', 200) / src.width)), Image.LANCZOS)
        if pop.get('label'):
            t = tag(pop['label'], seed + 80 + j, pop.get('label_px', 34)).rotate(pop.get('label_rot', -3), expand=True, resample=Image.BICUBIC)
            both = Image.new('RGBA', (max(img.width, t.width), img.height + t.height - 12), (0, 0, 0, 0))
            both.alpha_composite(img, ((both.width - img.width) // 2, 0))
            both.alpha_composite(t, ((both.width - t.width) // 2, img.height - 12))
            img = both
        img, pad = L.shadow(img.rotate(pop.get('rot', 0), expand=True, resample=Image.BICUBIC), {'dx': 3, 'dy': 9, 'blur': 12, 'opacity': 0.38})
        if pop['from'] == 'chimney':
            sx0, sy0 = CHIMNEY[2], -(wh + ROOF_H - 40 + CHIMNEY[1])
        else:
            sx0, sy0 = WINDOW[2], -(wh - WINDOW[3] - WINDOW[1] / 2)
        fly = pop.get('fly_s', 0.55)
        pcache = {}

        def pop_dyn(tt, p_at=p_at, img=img, pad=pad, sx0=sx0, sy0=sy0, pop=pop, fly=fly, pcache=pcache):
            dx = exit_dx(tt)
            if dx is None or tt < p_at:
                return None, 0, 0
            s = scene_scale(tt)
            an = scene_anchor(tt)
            u = (tt - p_at) / fly
            in_tk = tk and tk_in <= tt < tk_out
            if in_tk and not pop.get('to_tk'):  # the takeover is a push-in on the door: a byproduct with no place in it is out of shot
                return None, 0, 0
            tx, ty = pop['to_tk'] if in_tk else pop['to']
            if u < 1:
                e2 = L.ease_out(u)
                x = sx0 + (tx - sx0) * e2
                y = sy0 + (ty - sy0) * e2 - math.sin(math.pi * u) * pop.get('arc', 140)
                k = 0.35 + 0.65 * min(1.0, u * 1.6)
                st = 1.0 + 0.16 * math.sin(math.pi * u)  # stretch along the flight
                sxk, syk = k / st, k * st
            else:
                v = tt - p_at - fly
                x, y = tx, ty
                if v < 0.16:   # squash on landing, then overshoot and settle
                    q = v / 0.16
                    sxk, syk = 1 + 0.12 * math.sin(math.pi * q), 1 - 0.14 * math.sin(math.pi * q)
                elif v < 0.34:
                    q = (v - 0.16) / 0.18
                    sxk = syk = 1 + 0.05 * math.sin(math.pi * q)
                else:
                    sxk = syk = 1.0
            key = (round(sxk * s, 2), round(syk * s, 2))
            if key not in pcache:
                pcache[key] = img.resize((max(2, int(img.width * sxk * s)), max(2, int(img.height * syk * s))), Image.LANCZOS)
            im = pcache[key]
            return im, an[0] + x * s - im.width / 2 + dx, an[1] + y * s - im.height / 2

        spp = stage.Sprite(e.get('id', 'shop') + f'-pop{j}', None, 0, 0, p_at, 'none', 0, order=e.get('order', 54) + 4 + j, jitter=False)
        spp.dynamic = pop_dyn
        self.add(spp)
        if not tk or not (tk_in <= p_at < tk_out):
            tx, ty = pop['to']
            bx0, by0, bx1, by1 = self.opaque_box(img, ax + tx * S - img.width / 2, ay + ty * S - img.height / 2)  # the paper, not its shadow
            cx_, cy_ = ax + tx * S, ay + ty * S
            self.safe_box(e.get('id', 'shop') + f'-pop{j}', cx_ + (bx0 - cx_) * S, cy_ + (by0 - cy_) * S, cx_ + (bx1 - cx_) * S, cy_ + (by1 - cy_) * S,
                          p_at + fly, t_out)
        self.sound(f'w_pop{j % 4 + 1}', p_at)
        self.sound(f'w_land{j % 3 + 1}', p_at + fly)
        if pop['from'] == 'chimney':  # a paper puff leaves the chimney with each pop
            pf = puff(seed + 100 + j, 34)

            def puff_dyn(tt, p_at=p_at, pf=pf, sx0=sx0, sy0=sy0):
                dx = exit_dx(tt)
                v = tt - p_at
                if dx is None or v < 0 or v > 0.75:
                    return None, 0, 0
                s = scene_scale(tt)
                an = scene_anchor(tt)
                g = 0.5 + v * 1.4
                im = _scaled(pf, g * s)
                if v > 0.4:
                    im = im.copy()
                    im.putalpha(im.getchannel('A').point(lambda a: int(a * (1 - (v - 0.4) / 0.35))))
                return im, an[0] + sx0 * s - im.width / 2 + dx, an[1] + (sy0 - 30 - v * 90) * s - im.height / 2
            spu = stage.Sprite(e.get('id', 'shop') + f'-puff{j}', None, 0, 0, p_at, 'none', 0, order=e.get('order', 54) - 1, jitter=False)
            spu.dynamic = puff_dyn
            self.add(spu)

    # the takeover: a full-frame paper wall the scene stands on, cut in and cut out (no slide: it is a cut)
    if tk:
        wallpaper = L.paper(stage.W + 40, stage.H + 40, 'kraft', seed + 200, edge_amp=0, step=40)
        arr = np.asarray(wallpaper).astype(np.float32)
        yy = np.linspace(0, 1, arr.shape[0])[:, None]
        arr[..., :3] *= (0.82 + 0.18 * (1 - yy))[..., None]  # light falls from the top
        ground = int(tk.get('anchor', [0, stage.H - 120])[1])
        arr[ground:, :, :3] *= 0.72  # the ground the house stands on
        bg = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), 'RGBA').crop((20, 20, stage.W + 20, stage.H + 20))

        def bg_dyn(tt):
            return (bg, 0, 0) if tk_in <= tt < tk_out else (None, 0, 0)
        spb = stage.Sprite(e.get('id', 'shop') + '-takeover', None, 0, 0, tk_in, 'none', 0, order=e.get('order', 54) - 5, jitter=False)
        spb.dynamic = bg_dyn
        self.add(spb)
        self.sound('w_takeover', tk_in)

    self.sound('w_build', b_at)
    self.sound('w_out', t_out)
