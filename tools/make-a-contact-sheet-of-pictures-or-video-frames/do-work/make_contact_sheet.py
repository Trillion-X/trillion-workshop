#!/usr/bin/env python3
"""Lay pictures, or frames of a video, out as labelled contact sheets, to choose or check something by eye.

One JSON request (a file named as the only argument, or standard input); the last line printed is the answer,
{"result": {"sheets": [paths], "tiles": n}}, or {"error": "..."} with what to change.

Three kinds of request (`kind`):
  pictures          the given pictures in a grid, each with a label (its own words, or its file name)
  frames-at-times   one frame of a video at each given time (or at a steady rate between two times), each stamped with its
                    time by ffmpeg, `columns` to a row; `per_sheet` splits them over several sheets (frames_at_times.py)
  frames-at-a-rate  ffmpeg's own tile filter over a stretch of a video: frames at `fps`, stamped with their time or frame
                    number, `grid` columns x rows a sheet; every sheet, or only the first `sheets`

The older command line still works: make_contact_sheet.py out.jpg cols cellw "label|path" ... (a pictures sheet).
Every number, colour and font is a field of the request with the default named in the README; the tool keeps nothing.
Needs Pillow, and ffmpeg on the path for the video kinds."""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

from frames_at_times import Refusal, colour, frames_at_times, need


def from_argv():
    """Contact sheet: sheet.py out.jpg cols cellw "label|path" ..."""
    out, cols, cw = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    items = [a.split("|", 1) for a in sys.argv[4:]]
    return {'kind': 'pictures', 'out': out, 'columns': cols, 'cell_width': cw, 'pictures': [{'label': label, 'path': path} for label, path in items]}


def pictures(req):
    given = need(req, 'pictures', 'pictures')
    if not isinstance(given, list) or not given:
        raise Refusal('`pictures` must be a list of {path, label} with at least one picture')
    out = need(req, 'out', 'pictures')
    cols = int(req.get('columns', 3))
    cw = int(req.get('cell_width', 480))
    pad = int(req.get('pad', 6))
    label_of = req.get('label', {})
    where = label_of.get('where', 'below')
    if where not in ('below', 'above'):
        raise Refusal('label.where is "below" or "above"')
    text_of = label_of.get('text', 'given')
    if text_of not in ('given', 'file-name'):
        raise Refusal('label.text is "given" (each picture\'s label, else its file name) or "file-name"')
    items = []
    for it in given:
        path = it['path'] if isinstance(it, dict) else it
        if not os.path.isfile(path):
            raise Refusal(f'no picture at {path}')
        words = it.get('label') if isinstance(it, dict) else None
        items.append((os.path.basename(path) if text_of == 'file-name' or words is None else words, path))
    aspect = req.get('cell_aspect', '16:9')
    if aspect == 'first':
        first = Image.open(items[0][1])
        ch = int(cw * first.height / first.width)
    else:
        try:
            aw, ah = (int(v) for v in str(aspect).split(':'))
        except ValueError:
            raise Refusal('cell_aspect is "first" (the first picture\'s shape) or "w:h", e.g. "16:9"')
        ch = cw * ah // aw
    fit = req.get('fit', 'crop')
    if fit not in ('crop', 'stretch'):
        raise Refusal('fit is "crop" (keep the shape, cut the middle out when taller) or "stretch"')
    size = label_of.get('size')
    if label_of.get('font_file'):
        font = ImageFont.truetype(label_of['font_file'], int(size or max(14, cw // 22)))
    elif size:
        font = ImageFont.load_default(int(size))
    else:
        font = None
    # the label's strip: below the picture (with the padding round it) or above it
    lab = int(label_of.get('strip_px', size or max(14, cw // 22)) if where == 'below' else label_of.get('strip_px', 22))
    if where == 'above':
        lab -= 2 * pad
    dx, dy = label_of.get('offset', [0, 2] if where == 'below' else [4, 4])
    fill = colour(label_of.get('colour', [235, 235, 235]), 'label.colour')
    rows = (len(items) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (cw + pad) + pad, rows * (ch + lab + 2 * pad) + pad), colour(req.get('background', [24, 24, 24]), 'background'))
    d = ImageDraw.Draw(sheet)
    for i, (label, path) in enumerate(items):
        x = pad + (i % cols) * (cw + pad)
        y = pad + (i // cols) * (ch + lab + 2 * pad)
        im = Image.open(path).convert("RGB")
        if fit == 'crop':
            im = im.resize((cw, im.height * cw // im.width), Image.LANCZOS)
            if im.height > ch:
                t = (im.height - ch) // 2
                im = im.crop((0, t, cw, t + ch))
        else:
            im = im.resize((cw, ch))
        if where == 'below':
            sheet.paste(im, (x, y))
            d.text((x + dx, y + ch + dy), label, fill=fill, font=font)
        else:
            sheet.paste(im, (x, y + lab + 2 * pad))
            d.text((x + dx, y + dy), label, fill=fill, font=font)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    sheet.save(out, quality=int(req.get('quality', 88)))
    return {'sheets': [out], 'tiles': len(items)}


def frames_at_a_rate(req):
    video = need(req, 'video', 'frames-at-a-rate')
    if not os.path.isfile(video):
        raise Refusal(f'no video at {video}')
    out = need(req, 'out', 'frames-at-a-rate')
    fps = need(req, 'fps', 'frames-at-a-rate')
    cols, rows = req.get('grid', [6, 6])
    label = req.get('label', {})
    stamp_of = label.get('stamp', 'time')
    if stamp_of == 'time':
        text = "text='%{pts\\:hms}'"
    elif stamp_of == 'frame':
        text = 'text=%{n}:start_number=0'
    else:
        raise Refusal('label.stamp is "time" (hours:minutes:seconds of the video) or "frame" (the frame number, from 0)')
    font = [f"fontfile={label['font_file']}"] if label.get('font_file') else []
    vf = (f"fps={fps},scale={int(req.get('width', 384))}:{int(req.get('height', -2))},drawtext=" +
          ':'.join(font + [text, f"x={int(label.get('x', 4))}:y={int(label.get('y', 4))}", f"fontsize={int(label.get('size', 16))}",
                           f"fontcolor={label.get('colour', 'yellow')}", f"box=1:boxcolor={label.get('box', 'black@0.6')}"]) +
          f',tile={int(cols)}x{int(rows)}')
    args = (['-nostdin'] if req.get('nostdin', True) else []) + ['-v', 'error', '-y']
    if 'start' in req:
        args += ['-ss', str(req['start'])]
    if 'end' in req:
        args += ['-to', str(req['end'])]
    args += ['-i', video, '-vf', vf]
    if req.get('sheets'):
        args += ['-frames:v', str(int(req['sheets']))]
    if req.get('jpeg_qscale'):
        args += ['-q:v', str(int(req['jpeg_qscale']))]
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    r = subprocess.run(['ffmpeg', *args, out], capture_output=True, text=True)
    if r.returncode:
        raise Refusal(f'ffmpeg refused: {r.stderr.strip()[-400:]}')
    if '%' in out:
        folder, pattern = os.path.split(out)
        head = pattern.split('%')[0]
        written = sorted(os.path.join(folder, f) for f in os.listdir(folder or '.') if f.startswith(head) and f.endswith(os.path.splitext(out)[1]))
    else:
        written = [out]
    return {'sheets': written, 'tiles_per_sheet': int(cols) * int(rows)}


KINDS = {'pictures': pictures, 'frames-at-times': frames_at_times, 'frames-at-a-rate': frames_at_a_rate}


def main():
    try:
        if len(sys.argv) > 3:
            req = from_argv()
        else:
            raw = open(sys.argv[1]).read() if len(sys.argv) > 1 else sys.stdin.read()
            req = json.loads(raw or '{}')
        if not isinstance(req, dict) or req.get('kind') not in KINDS:
            raise Refusal('the request is a JSON object whose `kind` is "pictures", "frames-at-times" or "frames-at-a-rate"')
        print(json.dumps({'result': KINDS[req['kind']](req)}))
    except Refusal as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(json.dumps({'error': f'the request is not JSON: {e}'}))
        sys.exit(1)


if __name__ == '__main__':
    main()
