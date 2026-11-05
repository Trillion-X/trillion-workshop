#!/usr/bin/env python3
"""Per-box placement numbers with exit windows from film-qa --json outputs: show_exits.py <findings.json>..."""
import json
import sys

for f in sys.argv[1:]:
    for key, checks in json.load(open(f)).items():
        if key in ('_film_qa', '_run'):      # the run record of film-qa or of the Workshop's check-a-rendered-video
            continue
        for r in checks.get('placement', []):
            d = r.get('data') or {}
            if 'boxes' in d:
                print(f.split('pl-')[-1], {i: (None if b['heat'] is None else (round(b['heat'], 2), 'exit', round(b['exit']['heat'], 2) if b.get('exit') else None)) for i, b in d['boxes'].items()})
            elif 'id' in d:
                print(f.split('pl-')[-1], 'FAIL', d['id'], round(d['heat'], 2), d['frames'], 'frames')
