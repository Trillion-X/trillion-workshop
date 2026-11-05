"""Contact sheet: sheet.py out.jpg cols cellw "label|path" ..."""
import sys
from PIL import Image, ImageDraw, ImageFont
out, cols, cw = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
items = [a.split("|", 1) for a in sys.argv[4:]]
ch = cw * 9 // 16
lab = max(14, cw // 22)
font = ImageFont.truetype("/Library/Fonts/SF-Pro-Text-Semibold.otf", lab)
rows = (len(items) + cols - 1) // cols
pad = 6
sheet = Image.new("RGB", (cols * (cw + pad) + pad, rows * (ch + lab + 2 * pad) + pad), (24, 24, 24))
d = ImageDraw.Draw(sheet)
for i, (label, path) in enumerate(items):
    x = pad + (i % cols) * (cw + pad)
    y = pad + (i // cols) * (ch + lab + 2 * pad)
    im = Image.open(path).convert("RGB")
    im = im.resize((cw, im.height * cw // im.width), Image.LANCZOS)
    if im.height > ch:
        t = (im.height - ch) // 2
        im = im.crop((0, t, cw, t + ch))
    sheet.paste(im, (x, y))
    d.text((x, y + ch + 2), label, fill=(235, 235, 235), font=font)
sheet.save(out, quality=88)
