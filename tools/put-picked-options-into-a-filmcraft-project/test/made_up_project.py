#!/usr/bin/env python3
"""A made-up base project for the stand-in filmcraft-cli: a cut of `total_s` seconds whose V1 picture and its linked A1
sound are cut at `cuts` (seconds; every 37.3 s when none are given), a grade layer on V2 in two pieces, and empty V3 and
A2. Usage: made_up_project.py OUT.fcproj [total_s] [cut ...]"""
import json
import sys

T = 254016000000
FT = T * 1001 // 24000


def snap(t):
    return round(t * 24000 / 1001) * FT


def base_project(total_s=1201.2, cuts=None):
    end = snap(total_s)
    marks = sorted({snap(c) for c in (cuts if cuts is not None else [37.3 * k for k in range(1, int(total_s / 37.3) + 1)]) if 0 < snap(c) < end})
    bounds = [0] + marks + [end]
    state = {'sequence': {'video': [{'items': []}, {'items': []}, {'items': []}], 'audio': [{'items': []}, {'items': []}]},
             'root': {'children': []}, 'next': 0, 'linked': True, 'media': {}}
    for k, (a, b) in enumerate(zip(bounds, bounds[1:])):
        name = f'CLIP{k + 1:04d}.MP4'
        src = snap(20.0 + 3 * k)  # each camera clip starts some seconds into its own media
        for kind in ('video', 'audio'):
            state['next'] += 1
            state['sequence'][kind][0]['items'].append({'clip': f'c{state["next"]}', 'name': name, 'start': a, 'duration': b - a,
                                                        'sourceIn': src, 'enabled': True})
    half = snap(total_s / 2)
    for a, b in ((0, half), (half, end)):
        state['next'] += 1
        state['sequence']['video'][1]['items'].append({'clip': f'c{state["next"]}', 'name': 'Adjustment Layer', 'start': a, 'duration': b - a,
                                                       'sourceIn': 0, 'enabled': True})
    return state


if __name__ == '__main__':
    out = sys.argv[1]
    total = float(sys.argv[2]) if len(sys.argv) > 2 else 1201.2
    cuts = [float(x) for x in sys.argv[3:]] or None
    with open(out, 'w') as fh:
        json.dump(base_project(total, cuts), fh)
