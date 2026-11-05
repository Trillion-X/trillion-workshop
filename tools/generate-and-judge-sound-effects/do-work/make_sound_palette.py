"""Render the palette described in a palette file (palette.json), then verify every rendered file with earshot.

Each sound: decode the source (its src, relative to ROOT) at the palette's rate and channels, cut the trim, fade in and out, scale to the
target sample peak, write 24-bit WAV to OUT/<name>.wav. Then earshot reads the FINAL file:
match (z for the sound's query), describe, realness, measure. Writes OUT/palette_readings.json; the last line printed is {"result": {...}}.
Usage: <earshot venv python> -I make_sound_palette.py PALETTE.json ROOT OUT
"""
import json
import os
import subprocess
import sys

import numpy as np
import soundfile as sf

from earshot import api

ROOT = OUT = None   # the folder the palette's src paths are relative to, and the folder the palette is written to (argv)


def decode(path, rate, ch):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', str(ch), '-ar', str(rate), '-f', 'f32le', '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, ch).copy()


def render(spec, s):
    rate, ch = spec['rate'], spec['channels']
    x = decode(os.path.join(ROOT, s['src']), rate, ch)
    a, b = int(round(s['trim'][0] * rate)), int(round(s['trim'][1] * rate))
    y = x[a:b].astype(np.float64)
    fi, fo = int(spec['fade_in_s'] * rate), int(spec['fade_out_s'] * rate)
    y[:fi] *= np.linspace(0.0, 1.0, fi)[:, None]
    y[-fo:] *= np.linspace(1.0, 0.0, fo)[:, None]
    y *= 10 ** (spec['peak_dbfs'] / 20) / np.max(np.abs(y))
    out = os.path.join(OUT, f"{s['name']}.wav")
    sf.write(out, y, rate, subtype='PCM_24')
    return out


def main(palette):
    with open(palette) as fh:
        spec = json.load(fh)
    os.makedirs(OUT, exist_ok=True)
    readings = []
    for s in spec['sounds']:
        out = render(spec, s)
        m = api.match(out, s['query'])
        d = api.describe(out, top=5)
        r = api.realness(out)
        ms = api.measure(out)
        info = sf.info(out)
        row = dict(s, file=out, rate=info.samplerate, channels=info.channels, seconds=round(info.duration, 3),
                   final_match_z=m['z'], final_verdict=m['verdict'], final_describe=d['summary'][:500],
                   final_p_real=r['p_real'], final_realness=r['verdict'], final_lufs=ms.get('lufs'),
                   final_peak_dbfs=ms.get('peak_dbfs'), final_true_peak_dbtp=ms.get('true_peak_dbtp'),
                   final_attack_ms=ms.get('attack_ms'), final_decay_ms=ms.get('decay_ms'),
                   final_centroid_hz=ms.get('centroid_hz'))
        readings.append(row)
        print(f"{s['name']:18s} {row['seconds']:6.3f}s {info.samplerate} Hz x{info.channels} z {m['z']:+.2f} "
              f"p_real {r['p_real']} {r['verdict']} LUFS {row['final_lufs']} peak {row['final_peak_dbfs']} "
              f"atk {row['final_attack_ms']} dec {row['final_decay_ms']}", file=sys.stderr, flush=True)
    with open(os.path.join(OUT, 'palette_readings.json'), 'w') as fh:
        json.dump(readings, fh, indent=1, default=str)
    return {'out': OUT, 'sounds': len(readings), 'readings': os.path.join(OUT, 'palette_readings.json')}


if __name__ == '__main__':
    ROOT, OUT = sys.argv[2], sys.argv[3]
    print(json.dumps({'result': main(sys.argv[1])}))
