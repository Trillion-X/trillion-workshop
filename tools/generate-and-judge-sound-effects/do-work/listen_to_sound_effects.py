"""Listen to every SFX category with earshot (models load once): rank, find the cleanest trim, describe, realness, measure.

Per category (CATS below, the precise descriptions are DATA): rank the folder, then for the top candidates find the
best segments, refine a 'head cut' / 'tail cut' trim by moving its edge outward (5 ms steps) until the edge is at or
below -30 dB of the trim's peak, then describe / realness / measure that trim.
Writes sound/sfx/listen.json. Usage: python -I sfx_listen.py [category ...]
"""
import json
import os
import sys

import numpy as np

from earshot import api, audio

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CATS = {
    'key': dict(query='a single soft laptop keyboard key press, close and dry', kind='event', top=5,
                alts=['a loud clacky mechanical keyboard', 'a typewriter key', 'a camera shutter', 'a gunshot']),
    'riser': dict(query='a short airy uplifter riser sweeping upward', kind='auto', top=8,
                  alts=['a reverse cymbal crash', 'a jet engine passing', 'a gust of wind', 'a siren']),
    'hit': dict(query='a deep low cinematic boom hit with a long tail', kind='event', top=5,
                alts=['an explosion', 'a kick drum', 'a door slam', 'thunder']),
    'whoosh': dict(query='a soft fast air whoosh passing by', kind='auto', top=5,
                   alts=['a sword swing', 'wind blowing', 'a jet passing', 'a car passing']),
    'chime': dict(query='a single clean soft bell chime ringing out', kind='event', top=5,
                  alts=['a doorbell ding dong', 'a cartoon jingle', 'a phone ringtone', 'a church bell']),
    'sting': dict(query='a cinematic logo reveal sting, a shimmering impact with a warm long tail', kind='event', top=8,
                  alts=['an explosion', 'a trailer horn braam', 'a cartoon jingle', 'a gong']),
    'sting_note': dict(folder='sting', query='a single soft resonant singing bowl or bell tone ringing out', kind='event',
                       top=8, alts=['a gong crash', 'a doorbell ding dong', 'a church bell', 'a cartoon jingle']),
    'tick': dict(query='a tiny short crisp tick click', kind='event', top=5,
                 alts=['a clock ticking repeatedly', 'a mouse double click', 'a finger snap', 'a beep']),
}
EDGE_DB = -30.0
STEP = 0.005


def edge_db(x, a, b, head):
    seg = x[a:b]
    peak = np.max(np.abs(seg)) + 1e-12
    n = int(0.005 * audio.SR) if head else int(0.010 * audio.SR)
    part = seg[:n] if head else seg[-n:]
    return 20 * np.log10(np.max(np.abs(part)) / peak + 1e-12)


def refine(path, start, end):
    """move the trim's edges outward until both are clean (<= EDGE_DB); returns start, end, head_db, tail_db"""
    x = audio.load(path, mono=True)
    sr = audio.SR
    a, b = int(start * sr), min(len(x), int(end * sr))
    while a > 0 and edge_db(x, a, b, True) > EDGE_DB and (start - a / sr) < 0.05:
        a = max(0, a - int(STEP * sr))
    while b < len(x) and edge_db(x, a, b, False) > EDGE_DB and (b / sr - end) < 4.0:
        b = min(len(x), b + int(STEP * sr))
    return round(a / sr, 3), round(b / sr, 3), round(float(edge_db(x, a, b, True)), 1), round(float(edge_db(x, a, b, False)), 1)


def listen(cat, spec):
    folder = os.path.join(ROOT, 'sfx', spec.get('folder', cat))
    rk = api.rank([folder], spec['query'])
    rows = []
    for r in rk['results'][:spec['top']]:
        f = r['path']
        fd = api.find(f, spec['query'], top=3, kind=spec['kind'])
        segs = fd.get('segments') or fd.get('results') or []
        if not segs:
            continue
        seg = sorted(segs, key=lambda s: (bool(s.get('cut')), -s['z']))[0]
        s0, s1, head, tail = refine(f, seg['start'], seg['end'])
        m = api.match(f, spec['query'], alts=spec['alts'], start=s0, end=s1)
        d = api.describe(f, start=s0, end=s1, top=5)
        rl = api.realness(f, start=s0, end=s1)
        ms = api.measure(f, start=s0, end=s1)
        rows.append(dict(file=f, name=os.path.basename(f), rank_z=r['z'], rank_like=r.get('sounds_most_like'),
                         find_z=seg['z'], find_kind=seg['kind'], find_cut=seg.get('cut'),
                         find_range=[seg['start'], seg['end']], trim=[s0, s1], head_db=head, tail_db=tail,
                         match_z=m['z'], p_vs_alts=m.get('p_vs_alts'), match_summary=m['summary'],
                         describe=d['summary'], p_real=rl['p_real'], realness=rl['verdict'],
                         realness_summary=rl['summary'][:300], lufs=ms.get('lufs'), peak_dbfs=ms.get('peak_dbfs'),
                         attack_ms=ms.get('attack_ms'), decay_ms=ms.get('decay_ms'),
                         centroid_hz=ms.get('centroid_hz'), bandwidth_hz=ms.get('bandwidth_hz'),
                         duration=round(s1 - s0, 3)))
        x = rows[-1]
        print(f"{cat:6s} {x['name'][:44]:44s} rank z {x['rank_z']} find z {x['find_z']} match z {x['match_z']} "
              f"trim {s0:.3f}-{s1:.3f} head {head} tail {tail} p_real {x['p_real']} {x['realness']} "
              f"LUFS {x['lufs']} atk {x['attack_ms']} dec {x['decay_ms']}", flush=True)
    return dict(query=spec['query'], alts=spec['alts'], rank_summary=rk['summary'], candidates=rows)


def main(cats):
    out_path = os.path.join(ROOT, 'sfx', 'listen.json')
    out = json.load(open(out_path)) if os.path.exists(out_path) else {}
    for cat in cats or list(CATS):
        out[cat] = listen(cat, CATS[cat])
        json.dump(out, open(out_path, 'w'), indent=1, default=str)


if __name__ == '__main__':
    main(sys.argv[1:])
