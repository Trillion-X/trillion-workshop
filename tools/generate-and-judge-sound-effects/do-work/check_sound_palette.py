"""Check every rendered palette file against the spec in palette.json: rate, channels, sample peak, fade edges, length
equal to the trim, and that every palette sound has a licence entry in sfx/manifest.json that is not blocked.
Exit 1 on any failure. Usage: python -I check_palette.py
"""
import json
import os
import sys

import numpy as np
import soundfile as sf

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


def main():
    spec = json.load(open(os.path.join(ROOT, 'scripts', 'palette.json')))
    manifest = json.load(open(os.path.join(ROOT, 'sfx', 'manifest.json')))
    fails = []
    for s in spec['sounds']:
        path = os.path.join(ROOT, 'palette', f"{s['name']}.wav")
        y, rate = sf.read(path, always_2d=True)
        peak = 20 * np.log10(np.max(np.abs(y)))
        want_len = round((s['trim'][1] - s['trim'][0]) * rate)
        checks = {
            'rate': rate == spec['rate'],
            'channels': y.shape[1] == spec['channels'],
            'peak': abs(peak - spec['peak_dbfs']) < 0.05,
            'length': abs(len(y) - want_len) <= 1,
            'starts_silent': np.max(np.abs(y[0])) < 1e-3,
            'ends_silent': np.max(np.abs(y[-1])) < 1e-3,
            'licensed': s['manifest'] in manifest and manifest[s['manifest']].get('file')
                        and not manifest[s['manifest']].get('blocked'),
        }
        bad = [k for k, ok in checks.items() if not ok]
        print(f"{s['name']:18s} {rate} Hz x{y.shape[1]} peak {peak:.2f} dBFS {len(y)} samples "
              f"{'OK' if not bad else 'FAIL ' + ','.join(bad)}")
        fails += bad
    for name in ('1-buckley-meanwhile_129-179s.wav', '2-buckley-adrift-among-infinite-stars_35-85s.wav'):
        info = sf.info(os.path.join(ROOT, 'music', 'chosen', name))
        ok = info.samplerate == 48000 and info.channels == 2 and info.duration >= 45
        print(f'{name}: {info.samplerate} Hz x{info.channels} {info.duration:.2f} s {"OK" if ok else "FAIL"}')
        fails += [] if ok else [name]
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
