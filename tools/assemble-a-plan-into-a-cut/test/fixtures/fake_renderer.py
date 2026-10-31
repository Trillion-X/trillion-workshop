"""A stand-in overlay renderer for the tests: reads a spec file, writes into an out folder.

usage: python3 fake_renderer.py <spec.json> <out folder> [--stills s ...]

Without --stills: overlay.mov (transparent, the spec's frame size, its duration), sound.wav (silence with one click at each
event's "at") and timeline.json (each event's id and at). With --stills: one RGBA PNG per second named, transparent except an
opaque box for each event that has "box" [x0, y0, x1, y1], or "pos" [x, y] with "w" and "h", and up at that second. A spec with
"fill_colour" paints the whole still that colour (a slide).
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from PIL import Image, ImageDraw


def up(e, t):
    times = [v for k, v in e.items() if k in ('at', 'out') and isinstance(v, (int, float))]
    return not times or (e.get('at', 0) <= t <= e.get('out', float('inf')))


def main():
    spec_file, out = Path(sys.argv[1]), Path(sys.argv[2])
    stills = sys.argv[sys.argv.index('--stills') + 1:] if '--stills' in sys.argv else []
    spec = json.loads(spec_file.read_text())
    w, h = spec['frame']
    out.mkdir(parents=True, exist_ok=True)
    if stills:
        for s in stills:
            t = float(s)
            im = Image.new('RGBA', (w, h), tuple(spec['fill_colour']) + (255,) if 'fill_colour' in spec else (0, 0, 0, 0))
            draw = ImageDraw.Draw(im)
            for e in spec['events']:
                if not up(e, t):
                    continue
                if 'box' in e:
                    draw.rectangle(e['box'], fill=(255, 255, 255, 255))
                elif 'pos' in e and 'w' in e and 'h' in e:
                    draw.rectangle([e['pos'][0], e['pos'][1], e['pos'][0] + e['w'], e['pos'][1] + e['h']], fill=(255, 255, 255, 255))
            im.save(out / f'still-{t:06.2f}.png')
        return
    dur = spec['duration_s']
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'color=c=black@0.0:s={w}x{h}:r=24000/1001:d={dur}',
                    '-vf', 'format=rgba', '-c:v', 'png', str(out / 'overlay.mov')], check=True)
    sr = 48000
    y = np.zeros((int(dur * sr) + 1, 2), dtype=np.float32)
    for e in spec['events']:
        if isinstance(e.get('at'), (int, float)):
            k = int(e['at'] * sr)
            y[k:k + 240] += 0.05
    sf.write(out / 'sound.wav', y, sr, subtype='PCM_24')
    (out / 'timeline.json').write_text(json.dumps({'id': spec['id'], 'events': [{'id': e.get('id'), 'at': e.get('at')} for e in spec['events']]}))


main()
