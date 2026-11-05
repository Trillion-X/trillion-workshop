"""Build thumbnail candidates from real frames with six layout templates, each candidate one row of values.

One JSON request (a file named as the first argument, or standard input), run under tools/settings run-with-settings so a
person's settings row (`settings_record`) can hold their candidates; the last line printed is the answer,
{"result": {"thumbnails": [paths]}}, or {"error": "..."} with what to change.

Request: `frames` (folder of full-size frames, <name>.png), `cutouts` (folder of cut-outs, <name>_cut.png, cut from the crop
whose top-left is `cut_offset` of the same frame), `out` (folder; each candidate is written as <id>.png), `font`
({"file": a TrueType/OpenType file, "variable": true when it is a variable font with the named styles below}),
`only` (candidate ids; all when absent), and `settings_record` / `settings` giving `candidates`: {id: {template, ...values}}.
The layout functions are the templates (KEEP); a candidate's values are its slots. Templates: split_claim,
face_right_stack, zoom_flaw, tags, hold_quote, corner_face (the README says which values each reads).
"""
import json
import math
import os
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

sys.path.insert(0, '/opt/settings/read-data')
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'settings', 'read-data'))
import settings as person_settings  # noqa: E402

FOLDER = 'compose-thumbnails-from-layout-templates'
K4 = None
CUT = None
CUT_OFF = (1000, 150)
FONT = {}
W, H = 1280, 720
RED = (214, 32, 39)
YELLOW = (255, 214, 0)
WHITE = (255, 255, 255)
BLACK = (0, 0, 0)


class Refusal(Exception):
    pass


def font(size, style="Condensed Heavy"):
    f = ImageFont.truetype(FONT["file"], size)
    if FONT.get("variable"):
        f.set_variation_by_name(style)
    return f


def punch(im, contrast=1.22, colour=1.18, bright=1.0):
    im = ImageEnhance.Contrast(im).enhance(contrast)
    im = ImageEnhance.Color(im).enhance(colour)
    if bright != 1.0:
        im = ImageEnhance.Brightness(im).enhance(bright)
    return im.filter(ImageFilter.UnsharpMask(2, 60, 2))


def frame(name):
    path = os.path.join(K4, f"{name}.png")
    if not os.path.isfile(path):
        raise Refusal(f"no frame {name}: put {name}.png in the frames folder")
    return Image.open(path).convert("RGB")


def cutout(name):
    path = os.path.join(CUT, f"{name}_cut.png")
    if not os.path.isfile(path):
        raise Refusal(f"no cut-out {name}: put {name}_cut.png in the cut-outs folder")
    return Image.open(path).convert("RGBA")


def crop_cover(im, cx, cy, w, h, out_w, out_h):
    """Crop a w x h window centred on (cx, cy) from im, clamped, and scale to out size."""
    x0 = int(max(0, min(im.width - w, cx - w / 2)))
    y0 = int(max(0, min(im.height - h, cy - h / 2)))
    return im.crop((x0, y0, x0 + w, y0 + h)).resize((out_w, out_h), Image.LANCZOS)


def sticker(cut, outline=10, shadow=18):
    """White outline + soft shadow around a cut-out (The Hustle cut-out treatment)."""
    a = cut.split()[3].point(lambda v: 255 if v > 110 else 0)
    pad = outline + shadow
    big = Image.new("L", (cut.width + 2 * pad, cut.height + 2 * pad), 0)
    big.paste(a, (pad, pad))
    ring = big.filter(ImageFilter.MaxFilter(outline * 2 + 1))
    sh = ring.filter(ImageFilter.GaussianBlur(shadow / 2)).point(lambda v: int(v * 0.55))
    out = Image.new("RGBA", big.size, (0, 0, 0, 0))
    out.paste((0, 0, 0, 255), (6, 8), sh)
    out.paste((255, 255, 255, 255), (0, 0), ring)
    body = Image.new("RGBA", big.size, (0, 0, 0, 0))
    body.paste(cut, (pad, pad))
    body.putalpha(Image.composite(body.split()[3], Image.new("L", big.size, 0), big))
    return Image.alpha_composite(out, body), pad


def place_cut(canvas, cut, scale, x, y, outline=10):
    """Paste a cut-out scaled by `scale`; (x, y) is where crop-space (0, 0) lands."""
    c = cut.resize((int(cut.width * scale), int(cut.height * scale)), Image.LANCZOS)
    c = Image.merge("RGBA", (*punch(c.convert("RGB")).split(), c.split()[3]))
    if outline:
        c, pad = sticker(c, outline)
    else:
        pad = 0
    canvas.alpha_composite(c, (int(x - pad), int(y - pad)))


def text_size(d, s, f):
    b = d.textbbox((0, 0), s, font=f)
    return b[2] - b[0], b[3] - b[1], b[0], b[1]


def boxed(canvas, s, x, y, size, fill=RED, colour=WHITE, pad=(18, 10), angle=0, style="Condensed Heavy"):
    """Text on a solid box. Returns the box (x0, y0, x1, y1) on the canvas."""
    f = font(size, style)
    d = ImageDraw.Draw(canvas)
    tw, th, ox, oy = text_size(d, s, f)
    bw, bh = tw + 2 * pad[0], th + 2 * pad[1]
    tile = Image.new("RGBA", (bw, bh), fill + (255,) if fill else (0, 0, 0, 0))
    ImageDraw.Draw(tile).text((pad[0] - ox, pad[1] - oy), s, font=f, fill=colour)
    if angle:
        tile = tile.rotate(angle, expand=True, resample=Image.BICUBIC)
    canvas.alpha_composite(tile, (int(x), int(y)))
    return (x, y, x + tile.width, y + tile.height)


def stroked(canvas, s, x, y, size, colour=YELLOW, stroke=BLACK, sw=8, style="Condensed Heavy", shadow=True):
    f = font(size, style)
    d = ImageDraw.Draw(canvas)
    if shadow:
        sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).text((x + 6, y + 8), s, font=f, fill=(0, 0, 0, 170), stroke_width=sw, stroke_fill=(0, 0, 0, 170))
        canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(6)))
    d.text((x, y), s, font=f, fill=colour, stroke_width=sw, stroke_fill=stroke)
    tw, th, ox, oy = text_size(d, s, f)
    return (x + ox, y + oy, x + ox + tw, y + oy + th)


def arrow(canvas, p0, p1, bend=0.3, width=14, colour=RED, head=40, outline=WHITE):
    """Curved arrow p0 -> p1 (quadratic Bezier bent sideways by `bend`)."""
    (x0, y0), (x1, y1) = p0, p1
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    nx, ny = -(y1 - y0), (x1 - x0)
    cx, cy = mx + nx * bend, my + ny * bend
    pts = []
    for i in range(41):
        t = i / 40
        pts.append(((1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x1,
                    (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y1))
    ang = math.atan2(y1 - pts[-4][1], x1 - pts[-4][0])
    tip = (x1, y1)
    l = (x1 - head * math.cos(ang - 0.5), y1 - head * math.sin(ang - 0.5))
    r = (x1 - head * math.cos(ang + 0.5), y1 - head * math.sin(ang + 0.5))
    body = pts[:-3]
    d = ImageDraw.Draw(canvas)
    if outline:
        d.line(body, fill=outline, width=width + 8, joint="curve")
        d.polygon([tip, l, r], fill=outline, outline=outline, width=8)
    d.line(body, fill=colour, width=width, joint="curve")
    d.polygon([tip, l, r], fill=colour)


def zoom_circle(canvas, src, src_c, src_r, at, r, ring=RED, line_to=None):
    """Magnifier: a circle of radius r at `at` showing src around src_c (radius src_r)."""
    sx, sy = src_c
    patch = src.crop((sx - src_r, sy - src_r, sx + src_r, sy + src_r)).resize((2 * r, 2 * r), Image.LANCZOS)
    patch = punch(patch, 1.3, 1.25)
    m = Image.new("L", (2 * r, 2 * r), 0)
    ImageDraw.Draw(m).ellipse((0, 0, 2 * r - 1, 2 * r - 1), fill=255)
    d = ImageDraw.Draw(canvas)
    if line_to:
        d.line([at, line_to], fill=ring, width=8)
        d.ellipse((line_to[0] - 16, line_to[1] - 16, line_to[0] + 16, line_to[1] + 16), outline=ring, width=7)
    canvas.paste(patch, (at[0] - r, at[1] - r), m)
    d.ellipse((at[0] - r, at[1] - r, at[0] + r, at[1] + r), outline=WHITE, width=12)
    d.ellipse((at[0] - r - 6, at[1] - r - 6, at[0] + r + 6, at[1] + r + 6), outline=ring, width=6)


def tag(canvas, s, x, y, size, angle=-12):
    """Yellow price tag with a punched hole (e12kLkRh8t4 / JP6QqR7YGZE tags)."""
    f = font(size, "Condensed Black")
    d0 = ImageDraw.Draw(canvas)
    tw, th, ox, oy = text_size(d0, s, f)
    hole = th * 0.9
    bw, bh = int(tw + hole + 50), int(th + 44)
    t = Image.new("RGBA", (bw + 20, bh + 20), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    notch = bh // 2
    poly = [(10 + notch, 10), (10 + bw, 10), (10 + bw, 10 + bh), (10 + notch, 10 + bh), (10, 10 + bh // 2)]
    d.polygon(poly, fill=YELLOW, outline=BLACK, width=4)
    hx = 10 + notch * 0.75
    d.ellipse((hx - 9, 10 + bh / 2 - 9, hx + 9, 10 + bh / 2 + 9), fill=(40, 40, 40))
    d.text((10 + hole + 30 - ox, 10 + 22 - oy), s, font=f, fill=BLACK)
    t = t.rotate(angle, expand=True, resample=Image.BICUBIC)
    sh = Image.new("RGBA", t.size, (0, 0, 0, 0))
    sh.paste((0, 0, 0, 150), (0, 0), t.split()[3])
    canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(5)), (int(x + 5), int(y + 7)))
    canvas.alpha_composite(t, (int(x), int(y)))


def blurred_bg(name, cx, cy, w, h, blur=18, dark=0.6, colour=1.0):
    im = crop_cover(frame(name), cx, cy, w, h, W, H)
    im = im.filter(ImageFilter.GaussianBlur(blur))
    im = ImageEnhance.Brightness(im).enhance(dark)
    im = ImageEnhance.Color(im).enhance(colour)
    return im.convert("RGBA")


# ---------- templates (KEEP) ----------

def t_split_claim(c):
    """tufNXRHmuls: person left half in own setting, subject right half, red boxed claim bottom-left across the split,
    red curved arrow from the claim to the subject."""
    cv = Image.new("RGBA", (W, H))
    fx, fy, fh = c["face"]
    left = punch(crop_cover(frame(c["person"]), fx, fy + fh * 0.55, int(fh * 1.75), int(fh * 2.0), 600, H))
    cv.paste(left, (0, 0))
    sx, sy, sw = c["subject"]
    right = punch(crop_cover(frame(c["subject_frame"]), sx, sy, sw, int(sw * H / 680), 680, H), 1.3, 1.3)
    cv.paste(right, (600, 0))
    ImageDraw.Draw(cv).line([(600, 0), (600, H)], fill=WHITE, width=6)
    b = boxed(cv, c["text"], 40, 520, 118, pad=(22, 12))
    arrow(cv, (b[2] - 60, b[1] - 6), c["arrow_to"], bend=-0.35)
    return cv


def t_face_right_stack(c):
    """4ENdX6wmb8A: big face right (about 40% width, eyes on camera), stacked lines left; middle line on a red box,
    others plain white; dark, simplified background behind the text."""
    cv = blurred_bg(c["bg"], *c["bg_box"], blur=14, dark=0.42)
    shade = Image.new("L", (W, H))
    ImageDraw.Draw(shade).rectangle((0, 0, W, H), fill=0)
    fx, fy, fh = c["face"]
    s = c["face_px"] / fh
    cut = cutout(c["person"])
    x = c["face_x"] - (fx - CUT_OFF[0]) * s
    y = c["face_y"] - (fy - CUT_OFF[1]) * s
    place_cut(cv, cut, s, x, y, outline=0)
    y0 = c.get("text_y", 150)
    for line in c["lines"]:
        txt, kind, size = line
        if kind == "box":
            b = boxed(cv, txt, 46, y0, size, pad=(18, 8))
        else:
            b = stroked(cv, txt, 60, y0, size, colour=WHITE, sw=0)
            b = (b[0], y0, b[2], b[3])
        y0 = b[3] + 18
    return cv


def t_zoom_flaw(c):
    """YwLFqqXiStw: red boxed question top-left (2 lines, stepped), the food large right, magnifier circle bottom-left
    on its texture with a red connector to the spot."""
    cv = blurred_bg(c["bg"], *c["bg_box"], blur=10, dark=0.85)
    fx, fy, fh = c["face"]
    s = c["face_px"] / fh
    place_cut(cv, cutout(c["person"]), s, c["cut_x"] - (fx - CUT_OFF[0]) * s, c["face_y"] - (fy - CUT_OFF[1]) * s, outline=9)
    src = frame(c["zoom_frame"])
    spot = (int(c["cut_x"] + (c["zoom_c"][0] - fx) * s), int(c["face_y"] + (c["zoom_c"][1] - fy) * s))  # the zoomed spot on the cut-out
    zoom_circle(cv, src, c["zoom_c"], c["zoom_r"], c["zoom_at"], 165, line_to=spot)
    y = 34
    for i, line in enumerate(c["lines"]):
        b = boxed(cv, line, 40 + i * 30, y, c.get("size", 112), pad=(20, 8))
        y = b[3] + 6
    return cv


def t_tags(c):
    """e12kLkRh8t4 / JP6QqR7YGZE: the product on a flat saturated backdrop with yellow price tags; here the person
    holds the product (sticker cut-out)."""
    cv = Image.new("RGBA", (W, H), c["backdrop"] + (255,))
    g = Image.new("L", (W, H))
    ImageDraw.Draw(g).ellipse((200, -200, 1300, 900), fill=120)
    cv.paste((255, 255, 255), (0, 0), g.filter(ImageFilter.GaussianBlur(160)).point(lambda v: v // 3))
    fx, fy, fh = c["face"]
    s = c["face_px"] / fh
    place_cut(cv, cutout(c["person"]), s, c["cut_x"] - (fx - CUT_OFF[0]) * s, c["face_y"] - (fy - CUT_OFF[1]) * s, outline=10)
    for txt, x, y, size, ang in c["tags"]:
        tag(cv, txt, x, y, size, ang)
    return cv


def t_hold_quote(c):
    """7QHaO14VRos: person right, cut out with a white outline, holding the food toward the lens; quoted words
    top-left in yellow; white arrow from the words to the food; busy setting behind."""
    cv = blurred_bg(c["bg"], *c["bg_box"], blur=6, dark=0.8, colour=1.1)
    fx, fy, fh = c["face"]
    s = c["face_px"] / fh
    place_cut(cv, cutout(c["person"]), s, c["cut_x"] - (fx - CUT_OFF[0]) * s, c["face_y"] - (fy - CUT_OFF[1]) * s, outline=11)
    b = stroked(cv, c["text"], 44, 30, c.get("size", 130), colour=YELLOW, sw=7)
    arrow(cv, (b[0] + 160, b[3] + 30), c["arrow_to"], bend=0.35, colour=WHITE, outline=BLACK, width=13)
    return cv


def t_corner_face(c):
    """xtwOj74oVaM: sceptical face cut-out lower-left with white outline, the scene full-bleed behind, yellow words
    with black stroke over the face's shoulder, arrow from the words into the scene."""
    cv = punch(crop_cover(frame(c["bg"]), *c["bg_box"], W, H)).convert("RGBA")
    cv = Image.alpha_composite(cv, Image.new("RGBA", (W, H), (0, 0, 0, 40)))
    fx, fy, fh = c["face"]
    s = c["face_px"] / fh
    place_cut(cv, cutout(c["person"]), s, c["cut_x"] - (fx - CUT_OFF[0]) * s, c["face_y"] - (fy - CUT_OFF[1]) * s, outline=10)
    y = c.get("text_y", 470)
    for line, x in c["lines"]:
        b = stroked(cv, line, x, y, c.get("size", 104), colour=YELLOW, sw=8)
        y = b[3] + 14
    arrow(cv, c["arrow_from"], c["arrow_to"], bend=-0.3, colour=YELLOW, outline=BLACK)
    return cv


TEMPLATES = {"split_claim": t_split_claim, "face_right_stack": t_face_right_stack, "zoom_flaw": t_zoom_flaw,
             "tags": t_tags, "hold_quote": t_hold_quote, "corner_face": t_corner_face}

def tuples(v):
    """JSON lists of numbers back to the tuples the templates add and unpack."""
    if isinstance(v, list):
        if v and all(isinstance(x, (int, float)) for x in v):
            return tuple(v)
        return [tuples(x) for x in v]
    if isinstance(v, dict):
        return {k: tuples(x) for k, x in v.items()}
    return v


def build(cid, c, out):
    if c.get("template") not in TEMPLATES:
        raise Refusal(f"candidate {cid}: template is one of {', '.join(TEMPLATES)}")
    try:
        im = TEMPLATES[c["template"]](c).convert("RGB")
    except KeyError as e:
        raise Refusal(f"candidate {cid} ({c['template']}) needs the value {e}")
    path = os.path.join(out, f"{cid}.png")
    im.save(path)
    return path


def main():
    global K4, CUT, CUT_OFF, FONT
    try:
        raw = open(sys.argv[1]).read() if len(sys.argv) > 1 else sys.stdin.read()
        req = json.loads(raw or '{}')
        for key in ("frames", "cutouts", "out", "font"):
            if key not in req:
                raise Refusal(f"the request needs `{key}` (see the README)")
        if not req["font"].get("file") or not os.path.isfile(req["font"]["file"]):
            raise Refusal("font.file must name a TrueType or OpenType file on this computer")
        mine = person_settings.request_settings(req, {"candidates": {}}, folder=FOLDER,
                                                tool="tool:compose-thumbnails-from-layout-templates")
        candidates = tuples(mine.get("candidates") or {})
        if not candidates:
            raise Refusal("no candidates: give settings_record (the person's row) or settings.candidates")
        K4, CUT, FONT = req["frames"], req["cutouts"], req["font"]
        CUT_OFF = tuple(req.get("cut_offset", CUT_OFF))
        os.makedirs(req["out"], exist_ok=True)
        ids = req.get("only") or list(candidates)
        missing = [cid for cid in ids if cid not in candidates]
        if missing:
            raise Refusal(f"no candidate {', '.join(missing)} in the settings")
        print(json.dumps({"result": {"thumbnails": [build(cid, candidates[cid], req["out"]) for cid in ids]}}))
    except (Refusal, person_settings.SettingError) as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
