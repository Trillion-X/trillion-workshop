"""The face in the picture, from the request's face reader: held frames with open eyes, and graphics kept clear of the face.

The face reader is a command (DATA: "face_reader": {"argv": [...]}) given picture files after its argv. It prints one line per file,
in order: `<name> eyes <open> ... mouth <open> box <x> <y> <w> <h>` (eye and mouth openness as height/width ratios, the face box
in pixels from the top left), or a line without "eyes" when it finds no face. Apple Vision's face landmarks give these numbers on a
Mac; any reader that prints the same line can stand in.
"""
import glob
import re
import shutil
import subprocess

import numpy as np
from PIL import Image

import media
from fill import Refused

EYES = re.compile(r'eyes ([\d.-]+) .*mouth ([\d.-]+)')
BOX = re.compile(r'box (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)')


class FaceReader:
    def __init__(self, reader):
        if not reader or not reader.get('argv'):
            raise Refused('this plan cuts recordings, so the request needs "face_reader": {"argv": [...]}, a command that prints one '
                          'eyes/mouth/box line per picture file (README: The face reader)')
        self.argv = [str(a) for a in reader['argv']]

    def lines(self, pngs):
        r = subprocess.run([*self.argv, *map(str, pngs)], capture_output=True, text=True)
        if r.returncode:
            raise Refused(f'the face reader failed ({r.returncode}): {r.stderr.strip()[-400:]}')
        return r.stdout.strip().splitlines()

    def box(self, png):
        """(x, y, w, h) of the face in one picture, or None"""
        m = BOX.search('\n'.join(self.lines([png])))
        return tuple(float(v) for v in m.groups()) if m else None

    def boxes(self, src, chain, t0, secs, work, name, count):
        """face boxes on up to count frames spread over source seconds t0 .. t0+secs"""
        d = work / 'faces' / name
        d.mkdir(parents=True, exist_ok=True)
        media.run(['-ss', f'{t0:.3f}', '-t', f'{secs:.3f}', '-i', src, '-an', '-vf', f'{chain},fps={count / max(secs, 0.5):.4f}', '-frames:v', str(count),
                   str(d / 'f%02d.png')])
        found = [tuple(float(v) for v in m.groups()) for m in BOX.finditer('\n'.join(self.lines(sorted(glob.glob(str(d / 'f*.png'))))))]
        shutil.rmtree(d, ignore_errors=True)
        return found


def _small(png):
    return np.asarray(Image.open(png).convert('L').resize((240, 135)), dtype=np.float32)


def best_frame(reader, src, tc, work, tag, rules, match=True):
    """(time, eyes, mouth, ok, diff): an open-eyed frame (eyes >= eyes_open, mouth < mouth_max) within search_s of the source frame tc,
    the window widening by the rules' multiples. Of the open-eyed frames the one most like the frame at tc (mean grey difference) is
    taken, and the search widens past a window whose best still differs by more than match_diff (match False: it stops at the first
    window with one). With none, the frame with open eyes but an open mouth most like tc (ok False), else the most open eyes."""
    h = rules['hold']
    best, talking, rows = None, None, []
    for times in h['widen']:
        span = times * h['search_s']
        d = work / 'eyes' / f'{tag}-{span}'
        d.mkdir(parents=True, exist_ok=True)
        t0 = max(0.0, tc - span)
        media.run(['-ss', f'{t0:.3f}', '-t', f'{2 * span:.3f}', '-i', src, '-an', '-vf', f'fps={h["probe_fps"]},scale={h["probe_width"]}:-1', str(d / 'f%03d.png')])
        pngs = sorted(glob.glob(str(d / 'f*.png')))
        out = reader.lines(pngs)
        ref = _small(pngs[min(len(pngs) - 1, round((tc - t0) * h['probe_fps']))])
        rows = []
        for k, line in enumerate(out):
            m = EYES.search(line)
            if m:
                rows.append((t0 + k / h['probe_fps'], float(m[1]), float(m[2]), k))
        eyed = [(float(np.abs(_small(pngs[k]) - ref).mean()), (t, e, mo), mo < h['mouth_max']) for t, e, mo, k in rows if e >= h['eyes_open']]
        good = [g[:2] for g in eyed if g[2]]
        talking = min([*(g[:2] for g in eyed), *([talking] if talking else [])], default=None)
        if good:
            best = min([*good, *([best] if best else [])])
            if not match or best[0] <= h['match_diff']:
                break
    if best:
        return (*best[1], True, best[0])
    if talking:
        return (*talking[1], False, talking[0])
    if not rows:
        return (tc, -1.0, -1.0, False, None)
    return (*max(rows, key=lambda r: r[1] - 0.5 * r[2])[:3], False, None)


def away_left(reader, png, rules):
    """True when graphics go on the left: the face is in the right half of the frame, or no face is found"""
    face = reader.box(png)
    return face is None or face[0] + face[2] / 2 >= rules['frame']['width'] / 2


def calm_left(src, chain, t0, secs, band, rules):
    """True when the left probe box (rows band = (y0, y1) in frame pixels) moves no more than the right one over source seconds
    t0 .. t0+secs (a graphic never sits over the part of the picture where something is being shown or done)"""
    cp, W, H = rules['placement']['calm_probe'], rules['frame']['width'], rules['frame']['height']
    w, h = cp['width'], cp['height']
    raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-ss', f'{t0:.3f}', '-t', f'{secs:.3f}', '-i', src, '-an', '-vf',
                          f'{chain},fps={cp["fps"]},scale={w}:{h},format=gray', '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
    f = np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)
    if len(f) < 2:
        return True
    d = np.abs(np.diff(f, axis=0)).mean(axis=0)
    y0, y1, x = band[0] * h // H, band[1] * h // H, cp['x_px'] * w // W
    return float(d[y0:y1, :x].mean()) <= float(d[y0:y1, w - x:].mean())


def corner(reader, src, chain, t0, secs, size, inset, heights, calm, work, name, rules):
    """(left, y) of a side graphic of size (width, height): the face box on frames spread over t0 .. t0+secs, padded and raised by
    half its height for hair. The highest of heights where one side keeps clear of the face wins (both clear: the calmer side over
    calm = (seconds, band)); when no place is clear, the place that covers least of it."""
    width, height = size
    pad, W = rules['placement']['face_pad_px'], rules['frame']['width']
    boxes = reader.boxes(src, chain, t0, secs, work, name, rules['placement']['face_frames'])

    def covered(x0, y0):
        x1, y1 = x0 + width, y0 + height
        return sum(max(0.0, min(x1, fx + fw + pad) - max(x0, fx - pad)) * max(0.0, min(y1, fy + fh + pad) - max(y0, fy - fh / 2 - pad))
                   for fx, fy, fw, fh in boxes)
    places = [(covered(inset['left'], y), covered(W - inset['right'] - width, y), y) for y in heights]
    for left, right, y in places:
        if left == 0 and right == 0:
            return calm_left(src, chain, t0, min(secs, calm[0]), calm[1], rules), y
        if left == 0 or right == 0:
            return left == 0, y
    best = min((c, k, y) for k, (left, right, y) in enumerate(places) for c in (left, right))
    left, right, y = places[best[1]]
    return left <= right, y
