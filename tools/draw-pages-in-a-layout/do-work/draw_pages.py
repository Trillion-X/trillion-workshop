#!/usr/bin/env python3
# tools/draw-pages-in-a-layout/do-work/draw_pages.py
"""Draw a deck's pages as 1080x1350 JPEGs from the exact page text a person judged, in a layout the caller gives as DATA.

The tool adds no words of its own: every word drawn is a word of the `pages` text, and a line that is not a title, a
heading or a bullet is refused by name. The layout (`layout.css`) is the caller's; the tool adds only the structural classes
(`.p` the page, `.t` the title, `h2`, `ul`/`li`) and the page size.

One JSON request, from the file named as the first argument or from standard input:
  {"pages": "PAGE 1\\nA title with *marked words*\\n## ...", "layout": {"css": "...", "width": 1080, "height": 1350},
   "folder": "/absolute/folder"}
Output: the last line on standard output is {"files": [absolute NN.jpg paths in page order], "pages": N}, or
{"error": what to change} with exit status 1 (the same error is written to standard error).
"""
import glob
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_WIDTH, DEFAULT_HEIGHT = 1080, 1350
OVERFLOW_ROOM = 1500  # px rendered below a page, to find where its words end
PAGE_LINE = re.compile(r"^PAGE\s+(\d+)$")
MARKED = re.compile(r"\*([^*]+)\*")
CHROME_CACHE = Path.home() / "Library" / "Caches" / "ms-playwright"


class Refusal(Exception):
    """A request, page or page layout this tool refuses; the message says what to change."""


def parse_pages(text):
    """The judged line form -> [{"title": str|None, "blocks": [{"h2": str} | {"ul": [str, ...]}]}, ...] (one per PAGE)."""
    sections = []
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        match = PAGE_LINE.match(line)
        if match:
            if int(match.group(1)) != len(sections) + 1:
                raise Refusal(f'line {number} "{line}": pages are numbered 1, 2, 3 in order; PAGE {len(sections) + 1} comes next')
            sections.append([])
        elif not sections:
            raise Refusal(f'line {number} "{line}": the text must start with PAGE 1')
        else:
            sections[-1].append((number, line))
    if not sections:
        raise Refusal("pages holds no PAGE line: start page 1 with a line PAGE 1")
    return [build_page(index, lines) for index, lines in enumerate(sections, 1)]


def is_bullet(line):
    return line.startswith("- ")


def build_page(index, lines):
    title = None
    if index == 1:
        if not lines or is_bullet(lines[0][1]):
            raise Refusal("page 1 needs its title on the line right after PAGE 1")
        title = lines.pop(0)[1]
    blocks = []
    position = 0
    while position < len(lines):
        number, line = lines[position]
        if is_bullet(line):
            items = []
            while position < len(lines) and is_bullet(lines[position][1]):
                text = lines[position][1][2:].strip()
                if not text:
                    raise Refusal(f"line {lines[position][0]}: a bullet needs words after its dash")
                items.append(text)
                position += 1
            blocks.append({"ul": items})
        elif position + 1 < len(lines) and is_bullet(lines[position + 1][1]):
            blocks.append({"h2": line})
            position += 1
        else:
            raise Refusal(f'line {number} "{line}" is not a title, a heading or a bullet: a heading is a line that a bullet follows')
    if title is None and not blocks:
        raise Refusal(f"page {index} has no words under its PAGE line")
    return {"title": title, "blocks": blocks}


def title_html(title):
    """The title escaped, with each *marked* span drawn inside <mark> (the stars are not drawn)."""
    parts = MARKED.split(title)
    return "".join(f"<mark>{html.escape(part)}</mark>" if index % 2 else html.escape(part) for index, part in enumerate(parts))


def page_html(page, css, width, height):
    body = []
    if page["title"] is not None:
        body.append(f'<div class="t">{title_html(page["title"])}</div>')
    for block in page["blocks"]:
        if "h2" in block:
            body.append(f'<h2>{html.escape(block["h2"])}</h2>')
        else:
            body.append("<ul>" + "".join(f"<li>{html.escape(item)}</li>" for item in block["ul"]) + "</ul>")
    structure = f"html,body{{margin:0;width:{width}px}}.p{{position:relative;width:{width}px;height:{height}px}}"
    return f"<!doctype html><meta charset=utf-8><style>{structure}\n{css}</style><div class=\"p\">{''.join(body)}</div>"


def layout_of(request):
    layout = request.get("layout")
    if not isinstance(layout, dict) or not isinstance(layout.get("css"), str):
        raise Refusal('layout must be an object with a "css" string (the layout CSS from the person\'s format row)')
    if "<" in layout["css"]:
        raise Refusal("layout.css holds '<': the layout is CSS only, no markup")
    sizes = []
    for key, default in (("width", DEFAULT_WIDTH), ("height", DEFAULT_HEIGHT)):
        value = layout.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise Refusal(f"layout.{key} must be a whole number of pixels, 1 or more")
        sizes.append(value)
    return layout["css"], sizes[0], sizes[1]


def find_chromium():
    """CHROME when set (it must run), else the newest Playwright chrome-headless-shell, else one on PATH."""
    named = os.environ.get("CHROME")
    if named:
        if not os.access(named, os.X_OK):
            raise Refusal(f"CHROME is set to {named}, which is not an executable: point it at a chrome-headless-shell binary")
        return named
    found = glob.glob(str(CHROME_CACHE / "chromium_headless_shell-*" / "chrome-headless-shell-mac-arm64" / "chrome-headless-shell"))
    if found:
        return max(found, key=lambda path: int(re.search(r"chromium_headless_shell-(\d+)", path).group(1)))
    on_path = shutil.which("chrome-headless-shell")
    if on_path:
        return on_path
    raise Refusal("no headless Chromium found: set CHROME to a chrome-headless-shell binary, or install one with "
                  "`npx playwright install chromium-headless-shell`")


def screenshot(chrome, page_file, png, width, height):
    command = [chrome, "--headless", "--hide-scrollbars", f"--screenshot={png}", f"--window-size={width},{height}",
               "--force-device-scale-factor=1", page_file.as_uri()]
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=120)
    except subprocess.CalledProcessError as error:
        raise Refusal(f"Chromium could not draw {page_file.name}: {error.stderr.decode(errors='replace')[-300:]}") from error
    if not png.exists():
        raise Refusal(f"Chromium wrote no screenshot for {page_file.name}")


def words_end(png):
    """The row just below the last pixel that is not the page's background (the top-left pixel), or None when the page is blank."""
    from PIL import Image, ImageChops
    image = Image.open(png).convert("RGB")
    background = image.getpixel((0, 0))
    box = ImageChops.difference(image, Image.new("RGB", image.size, background)).getbbox()
    return None if box is None else box[3]


def page_words_end(chrome, page_file, tall, width, height):
    """Where a page's words end, measured on a window taller than the page: the window grows until the words fit in it."""
    room = OVERFLOW_ROOM
    while True:
        screenshot(chrome, page_file, tall, width, height + room)
        end = words_end(tall)
        if end is None or end < height + room:
            return end
        room *= 2


def to_jpeg(png, jpg):
    if sys.platform == "darwin" and shutil.which("sips"):
        command = ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "92", str(png), "--out", str(jpg)]
    elif shutil.which("ffmpeg"):
        command = ["ffmpeg", "-v", "error", "-y", "-i", str(png), "-q:v", "2", str(jpg)]
    else:
        raise Refusal("no JPEG converter: this needs sips (macOS) or ffmpeg on the computer")
    subprocess.run(command, check=True, capture_output=True, timeout=120)


def draw(request):
    if not isinstance(request, dict):
        raise Refusal("the request must be one JSON object")
    pages_text, folder = request.get("pages"), request.get("folder")
    if not isinstance(pages_text, str) or not pages_text.strip():
        raise Refusal('pages must be the judged page text as one string, starting with "PAGE 1"')
    if not isinstance(folder, str) or not os.path.isabs(folder):
        raise Refusal("folder must be an absolute path to the folder the pages are written into")
    css, width, height = layout_of(request)
    pages = parse_pages(pages_text)
    chrome = find_chromium()
    scratch = Path(tempfile.mkdtemp(prefix="draw-pages-"))
    try:
        for number, page in enumerate(pages, 1):
            page_file = scratch / f"{number:02d}.html"
            page_file.write_text(page_html(page, css, width, height), encoding="utf-8")
            end = page_words_end(chrome, page_file, scratch / f"{number:02d}-tall.png", width, height)
            if end is None:
                raise Refusal(f"page {number} draws no visible words: check the layout's colours")
            if end > height:
                raise Refusal(f"page {number} runs past the page by {end - height} px; use fewer words")
        out = Path(folder)
        out.mkdir(parents=True, exist_ok=True)
        files = []
        for number in range(1, len(pages) + 1):
            page_file = out / f"{number:02d}.html"
            page_file.write_text((scratch / f"{number:02d}.html").read_text(encoding="utf-8"), encoding="utf-8")
            png, jpg = out / f"{number:02d}.png", out / f"{number:02d}.jpg"
            screenshot(chrome, page_file, png, width, height)
            to_jpeg(png, jpg)
            files.append(str(jpg))
        return {"files": files, "pages": len(pages)}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def fail(message):
    sys.stderr.write(message + "\n")
    print(json.dumps({"error": message}))
    return 1


def main(argv):
    try:
        raw = Path(argv[1]).read_text(encoding="utf-8") if len(argv) > 1 else sys.stdin.read()
        result = draw(json.loads(raw))
    except Refusal as refusal:
        return fail(str(refusal))
    except ImportError as error:
        return fail(f"Pillow is needed ({error}): run python3 -m pip install -U pillow")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return fail(f"could not draw the pages: {error}")
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
