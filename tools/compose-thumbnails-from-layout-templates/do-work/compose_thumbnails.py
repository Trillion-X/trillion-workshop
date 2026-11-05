"""Build the thumbnail candidates from real graded frames.

python3 tools/build.py            # all candidates -> ../<id>.png
python3 tools/build.py T3 T5      # some

Frames: work/4k/<clip>_<t>.png (4K, final.cube applied). Cut-outs: work/cut/out/<clip>_<t>_cut.png
(rembg u2netp on the crop x1000..3000, y150..2160 of the same frame). Every candidate is one row in CANDIDATES;
the layout functions are the templates (KEEP), the row's values are the slots.
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent.parent
K4 = HERE / "work/4k"
CUT = HERE / "work/cut/out"
CUT_OFF = (1000, 150)
W, H = 1280, 720
RED = (214, 32, 39)
YELLOW = (255, 214, 0)
WHITE = (255, 255, 255)
BLACK = (0, 0, 0)


def font(size, style="Condensed Heavy"):
    f = ImageFont.truetype("/Library/Fonts/SF-Pro.ttf", size)
    f.set_variation_by_name(style)
    return f


def punch(im, contrast=1.22, colour=1.18, bright=1.0):
    im = ImageEnhance.Contrast(im).enhance(contrast)
    im = ImageEnhance.Color(im).enhance(colour)
    if bright != 1.0:
        im = ImageEnhance.Brightness(im).enhance(bright)
    return im.filter(ImageFilter.UnsharpMask(2, 60, 2))


def frame(name):
    return Image.open(K4 / f"{name}.png").convert("RGB")


def cutout(name):
    return Image.open(CUT / f"{name}_cut.png").convert("RGBA")


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
    spot = c["spot"](s)
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

# Face boxes (x, y, h) in the 4K frame, from OpenCV haar (work/4k).
F = {"C9940_16": (2146, 428, 492), "C9940_23.5": (1884, 408, 664), "C9940_33": (1972, 360, 608),
     "C9940_34": (2018, 428, 524), "C9940_67": (2012, 548, 496), "C9941_1": (1810, 340, 628),
     "C9941_2": (1934, 388, 620), "C9941_4": (2036, 412, 592)}
SCOOP = (1490, 1420)  # centre of the scooped ice cream in C9940_16 (4K)

CANDIDATES = {
    "T1": dict(template="split_claim", person="C9941_1", face=F["C9941_1"], subject_frame="C9940_16",
               subject=(1300, 1300, 900), text="488 CALORIES", arrow_to=(900, 420)),
    "T2": dict(template="split_claim", person="C9940_67", face=F["C9940_67"], subject_frame="C9940_16",
               subject=(1300, 1300, 900), text="JUST BEANS", arrow_to=(900, 420)),
    "T9": dict(template="split_claim", person="C9941_4", face=F["C9941_4"], subject_frame="C9940_16",
               subject=(1300, 1300, 900), text="56G PROTEIN", arrow_to=(900, 420)),
    "T3": dict(template="face_right_stack", person="C9940_67", face=F["C9940_67"], face_px=235, face_x=920,
               face_y=40, bg="C9940_16", bg_box=(1500, 1200, 1900, 1070),
               lines=[("56G", "plain", 210), ("PROTEIN", "box", 118)], text_y=150),
    "T4": dict(template="face_right_stack", person="C9940_33", face=F["C9940_33"], face_px=320, face_x=930,
               face_y=95, bg="C9940_16", bg_box=(1500, 1200, 1900, 1070),
               lines=[("488", "plain", 210), ("CALORIES", "box", 112)], text_y=150),
    "T5": dict(template="zoom_flaw", person="C9940_16", face=F["C9940_16"], face_px=250, cut_x=820, face_y=70,
               bg="C9940_16", bg_box=(2000, 1000, 2600, 1460), zoom_frame="C9940_16", zoom_c=SCOOP, zoom_r=170,
               zoom_at=(250, 520),
               spot=lambda s: (int(820 + (SCOOP[0] - 2146) * s), int(70 + (SCOOP[1] - 428) * s)),
               lines=["IT'S", "ICY"], size=142),
    "T6": dict(template="tags", person="C9940_16", face=F["C9940_16"], face_px=230, cut_x=800, face_y=40,
               backdrop=(28, 110, 220),
               tags=[("488 CAL", 50, 120, 104, 8), ("56G", 90, 330, 150, -8)]),
    "T7": dict(template="hold_quote", person="C9940_16", face=F["C9940_16"], face_px=260, cut_x=860, face_y=60,
               bg="C9940_16", bg_box=(1900, 1100, 2800, 1575), text="“JUST BEANS”",
               arrow_to=(520, 470)),
    "T8": dict(template="corner_face", person="C9940_34", face=F["C9940_34"], face_px=250, cut_x=220, face_y=360,
               bg="C9940_16", bg_box=(1400, 1250, 1500, 844),
               lines=[("112G", 600), ("PROTEIN?", 600)], text_y=40, size=138,
               arrow_from=(700, 360), arrow_to=(600, 500)),
}


def build(cid):
    c = CANDIDATES[cid]
    im = TEMPLATES[c["template"]](c).convert("RGB")
    out = HERE / f"{cid}.png"
    im.save(out)
    return out


if __name__ == "__main__":
    for cid in sys.argv[1:] or CANDIDATES:
        print(build(cid))
