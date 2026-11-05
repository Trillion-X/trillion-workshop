"""Check every rendered palette file against the spec in palette.json: rate, channels, sample peak, fade edges, length
equal to the trim, and that every palette sound has a licence entry in the manifest (the fetcher's manifest.json) that is not blocked;
every music file given has the palette's rate and channels and lasts at least LEAST_SECONDS. Exit 1 on any failure.
Usage: python -I check_sound_palette.py PALETTE.json PALETTE_FOLDER MANIFEST.json [LEAST_SECONDS MUSIC_FILE ...]
"""
import json
import os
import pathlib
import sys

import numpy as np
import soundfile as sf


def main(palette, folder, manifest_path, music):
    spec = json.loads(pathlib.Path(palette).read_text())
    manifest = json.loads(pathlib.Path(manifest_path).read_text())
    fails = []
    for s in spec['sounds']:
        path = os.path.join(folder, f"{s['name']}.wav")
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
    least = float(music[0]) if music else 0
    for name in music[1:]:
        info = sf.info(name)
        ok = info.samplerate == spec['rate'] and info.channels == spec['channels'] and info.duration >= least
        print(f'{name}: {info.samplerate} Hz x{info.channels} {info.duration:.2f} s {"OK" if ok else "FAIL"}')
        fails += [] if ok else [name]
    print(json.dumps({'result': {'passed': not fails, 'failed': fails}}))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:])
