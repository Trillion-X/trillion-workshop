"""Judge one-shot files as whole sounds: trim = first onset (-40 dB of peak) minus 5 ms .. last sample above -50 dB of
peak (or the file end), then match / describe / realness / measure that trim with earshot (models load once).

Usage: <earshot venv python> -I listen_to_whole_sounds.py OUT.json "<query>" "<alt1|alt2|...>" file...   (prints one JSON line per file; merges into
OUT.json keyed by file and query; the last line printed is {"result": {...}})
"""
import json
import os
import pathlib
import sys

import numpy as np

from earshot import api, audio


def whole_trim(path):
    x = audio.load(path, mono=True)
    a = np.abs(x)
    peak = a.max() + 1e-12
    on = np.nonzero(a > peak * 10 ** (-40 / 20))[0]
    off = np.nonzero(a > peak * 10 ** (-50 / 20))[0]
    s0 = max(0, on[0] - int(0.005 * audio.SR))
    s1 = min(len(x), off[-1] + int(0.010 * audio.SR))
    tail = 20 * np.log10(a[max(s0, s1 - int(0.010 * audio.SR)):s1].max() / peak + 1e-12)
    head = 20 * np.log10(a[s0:s0 + int(0.005 * audio.SR)].max() / peak + 1e-12)
    return round(s0 / audio.SR, 3), round(s1 / audio.SR, 3), round(float(head), 1), round(float(tail), 1)


def main(out_path, query, alts, files):
    out = json.loads(pathlib.Path(out_path).read_text()) if os.path.exists(out_path) else {}
    for f in files:
        s0, s1, head, tail = whole_trim(f)
        m = api.match(f, query, alts=alts, start=s0, end=s1)
        d = api.describe(f, start=s0, end=s1, top=5)
        r = api.realness(f, start=s0, end=s1)
        ms = api.measure(f, start=s0, end=s1)
        row = dict(file=f, query=query, trim=[s0, s1], head_db=head, tail_db=tail, match_z=m['z'],
                   p_vs_alts=m.get('p_vs_alts'), p_real=r['p_real'], realness=r['verdict'],
                   realness_summary=r['summary'][:400], describe=d['summary'][:600], lufs=ms.get('lufs'),
                   peak_dbfs=ms.get('peak_dbfs'), attack_ms=ms.get('attack_ms'), decay_ms=ms.get('decay_ms'),
                   centroid_hz=ms.get('centroid_hz'), bandwidth_hz=ms.get('bandwidth_hz'))
        out[f'{f}::{query}'] = row
        print(json.dumps({k: row[k] for k in ('trim', 'head_db', 'tail_db', 'match_z', 'p_real', 'realness', 'lufs',
                                              'attack_ms', 'decay_ms')} | {'name': os.path.basename(f)}), file=sys.stderr, flush=True)
        with open(out_path, 'w') as fh:
            json.dump(out, fh, indent=1, default=str)
    return {'out': out_path, 'heard': len(files)}


if __name__ == '__main__':
    print(json.dumps({'result': main(sys.argv[1], sys.argv[2], sys.argv[3].split('|') if sys.argv[3] else [], sys.argv[4:])}))
