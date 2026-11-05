#!/usr/bin/env python3
"""Contact sheet of frames of one video, each labelled with its time, three to a row (to choose or check a frame by eye).
Usage: contact_sheet.py <out.jpg> <video> <t> [<t> ...] [--width 640]
Also the `frames-at-times` kind of make_contact_sheet.py: `times`, or `every` {from, to, fps} (every 1/fps second from `from` up
to `to`, three decimals), `width`, `columns`, `per_sheet` (then `out` holds {k}, the sheet number from 1) and the stamp's `label`."""
import os, subprocess, sys, tempfile

from PIL import Image


class Refusal(Exception):
    pass


def need(req, key, kind):
    if key not in req:
        raise Refusal(f'a {kind} request needs `{key}`')
    return req[key]


def colour(value, name):
    if isinstance(value, str):
        return value
    if isinstance(value, list) and len(value) == 3 and all(isinstance(v, int) and 0 <= v <= 255 for v in value):
        return tuple(value)
    raise Refusal(f'{name} must be a colour name or [red, green, blue] from 0 to 255, not {value!r}')


def every(spec):
    """Times from `from` up to (not including) `to`, `fps` a second, written with three decimals."""
    t0, t1, fps = float(spec['from']), float(spec['to']), float(spec['fps'])
    times, t = [], t0
    while t < t1 - 1e-6:
        times.append('%.3f' % t)
        t += 1 / fps
    return times


def frames_at_times(req):
    video = need(req, 'video', 'frames-at-times')
    if not os.path.isfile(video):
        raise Refusal(f'no video at {video}')
    pattern = need(req, 'out', 'frames-at-times')
    if 'times' in req:
        times = [t if isinstance(t, str) else '%g' % t for t in req['times']]
    elif 'every' in req:
        times = every(req['every'])
    else:
        raise Refusal('a frames-at-times request needs `times` (a list of seconds) or `every` ({from, to, fps})')
    if not times:
        raise Refusal('no times to take frames at')
    width = int(req.get('width', 640))
    cols = int(req.get('columns', 3))
    label = req.get('label', {})
    per = int(req.get('per_sheet') or len(times))
    if per < len(times) and '{k}' not in pattern:
        raise Refusal('the frames go on more than one sheet: put {k} (the sheet number, from 1) in `out`')
    stamp = ':'.join(([f"fontfile={label['font_file']}"] if label.get('font_file') else []) +
                     [f"fontcolor={label.get('colour', 'white')}", f"fontsize={int(label.get('size', 26))}",
                      f"box=1:boxcolor={label.get('box', 'black@0.6')}", f"x={int(label.get('x', 8))}:y={int(label.get('y', 8))}"])
    sheets = []
    for k in range(0, len(times), per):
        out = pattern.replace('{k}', str(k // per + 1))
        tiles = []
        with tempfile.TemporaryDirectory() as d:
            for i, t in enumerate(times[k:k + per]):
                f = os.path.join(d, f'{i}.jpg')
                try:
                    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', t, '-i', video, '-frames:v', '1', '-vf',
                                    f"scale={width}:-1,drawtext=text='{t}':{stamp}", f], check=True, capture_output=True, text=True)
                except subprocess.CalledProcessError as e:
                    raise Refusal(f'ffmpeg refused the frame at {t} s: {e.stderr.strip()[-400:]}')
                tiles.append(Image.open(f).convert('RGB'))
        w, h = tiles[0].size
        rows = (len(tiles) + cols - 1) // cols
        sheet = Image.new('RGB', (w * cols, h * rows))
        for i, im in enumerate(tiles):
            sheet.paste(im, ((i % cols) * w, (i // cols) * h))
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        sheet.save(out, quality=88)
        sheets.append(out)
    return {'sheets': sheets, 'tiles': len(times)}


def main():
    a = sys.argv[1:]
    width = int(a[a.index('--width') + 1]) if '--width' in a else 640
    if '--width' in a:
        del a[a.index('--width'):a.index('--width') + 2]
    out, video, times = a[0], a[1], a[2:]
    try:
        frames_at_times({'video': video, 'times': times, 'width': width, 'out': out})
    except Refusal as e:
        sys.exit(str(e))


if __name__ == '__main__':
    main()
