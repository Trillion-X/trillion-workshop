"""Render the palette described in palette.json, then verify every rendered file with earshot.

Each sound: decode the source at 48 kHz stereo, cut the trim, 5 ms linear fade in / 20 ms linear fade out, scale to the
target sample peak (-6 dBFS), write 24-bit WAV to sound/palette/<name>.wav. Then earshot reads the FINAL file:
match (z for the sound's query), describe, realness, measure. Writes sound/palette/palette_readings.json.
Usage: python -I make_palette.py
"""
import json
import os
import subprocess

import numpy as np
import soundfile as sf

from earshot import api

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


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
    out = os.path.join(ROOT, 'palette', f"{s['name']}.wav")
    sf.write(out, y, rate, subtype='PCM_24')
    return out


def main():
    spec = json.load(open(os.path.join(ROOT, 'scripts', 'palette.json')))
    os.makedirs(os.path.join(ROOT, 'palette'), exist_ok=True)
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
              f"atk {row['final_attack_ms']} dec {row['final_decay_ms']}", flush=True)
    json.dump(readings, open(os.path.join(ROOT, 'palette', 'palette_readings.json'), 'w'), indent=1, default=str)


if __name__ == '__main__':
    main()
