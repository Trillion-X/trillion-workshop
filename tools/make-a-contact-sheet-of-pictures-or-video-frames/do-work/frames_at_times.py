#!/usr/bin/env python3
"""Contact sheet of frames of one video, each labelled with its time, three to a row (to choose or check a frame by eye).
Usage: contact_sheet.py <out.jpg> <video> <t> [<t> ...] [--width 640]"""
import os, subprocess, sys, tempfile

from PIL import Image


def main():
    a = sys.argv[1:]
    width = int(a[a.index('--width') + 1]) if '--width' in a else 640
    if '--width' in a:
        del a[a.index('--width'):a.index('--width') + 2]
    out, video, times = a[0], a[1], a[2:]
    tiles = []
    with tempfile.TemporaryDirectory() as d:
        for i, t in enumerate(times):
            f = os.path.join(d, f'{i}.jpg')
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', t, '-i', video, '-frames:v', '1', '-vf',
                            f"scale={width}:-1,drawtext=text='{t}':fontcolor=white:fontsize=26:box=1:boxcolor=black@0.6:x=8:y=8", f], check=True)
            tiles.append(Image.open(f).convert('RGB'))
        w, h = tiles[0].size
        cols = 3
        rows = (len(tiles) + cols - 1) // cols
        sheet = Image.new('RGB', (w * cols, h * rows))
        for i, im in enumerate(tiles):
            sheet.paste(im, ((i % cols) * w, (i // cols) * h))
        sheet.save(out, quality=88)


if __name__ == '__main__':
    main()
