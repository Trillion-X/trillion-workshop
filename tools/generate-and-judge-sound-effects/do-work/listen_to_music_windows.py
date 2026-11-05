"""Listen to every music excerpt with earshot (models load once).

For each excerpt from music_windows.py: per-section mood match against the Raycast film's own section words,
typicality against the Raycast music stem cut into its three sections, realness, and the top describe tags.
Writes sound/music/listen.json. Usage: python -I music_listen.py
"""
import json
import os
import subprocess

from earshot import api

import pathlib
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[2])  # this repository, wherever this place keeps it
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
STEM = CHECKOUT + '/.viral-clone/raycast-Mi173xGb0ZA/sep/htdemucs/raycast-Mi173xGb0ZA/no_vocals.wav'
REF_SECTIONS = [(0.0, 7.5), (7.5, 29.15), (29.15, 38.5)]
SECTIONS = [
    dict(name='open', start=0.0, end=7.5, query='calm minimal electronic music with soft electric piano'),
    dict(name='middle', start=7.5, end=29.0, query='ambient synth pad music with cinematic percussion, futuristic'),
    dict(name='resolve', start=29.0, end=45.0, query='warm analog synth pad music, dreamy and ethereal'),
]
ALTS = ['upbeat pop song with drums and bass', 'acoustic guitar folk music', 'solo classical piano piece',
        'heavy rock music with distorted guitars', 'orchestral string ensemble']


def ref_dir():
    d = os.path.join(ROOT, 'music', 'ref-sections')
    os.makedirs(d, exist_ok=True)
    for i, (a, b) in enumerate(REF_SECTIONS):
        out = os.path.join(d, f'raycast-section{i + 1}_{a:g}-{b:g}.wav')
        if not os.path.exists(out):
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(a), '-to', str(b), '-i', STEM, '-ar', '48000',
                            out], check=True)
    return d


def main():
    refs = ref_dir()
    win = json.load(open(os.path.join(ROOT, 'music', 'windows.json')))['windows']
    rows = []
    for w in win:
        exc = w['excerpt']
        row = dict(name=w['name'], excerpt=exc, start_s=w['start_s'], arc_score=w['arc_score'], sections={})
        zs = []
        for s in SECTIONS:
            m = api.match(exc, s['query'], alts=ALTS, start=s['start'], end=s['end'])
            z = m['z']
            zs.append(z)
            row['sections'][s['name']] = dict(query=s['query'], z=z, summary=m.get('summary'))
        row['mood_z_mean'] = round(sum(zs) / len(zs), 2)
        c = api.compare(exc, refs)
        row['typicality'] = {k: v for k, v in c.items() if 'typical' in k}
        row['compare_summary'] = c.get('summary')
        r = api.realness(exc)
        row['p_real'] = r.get('p_real')
        row['realness_verdict'] = r.get('verdict')
        d = api.describe(exc, top=5)
        row['describe_summary'] = d.get('summary')
        meas = api.measure(exc, music=True, light=True)
        row['lufs'] = meas['lufs']
        row['lra_lu'] = meas['lra_lu']
        rows.append(row)
        print(json.dumps(dict(name=row['name'], mood_z=zs, mean=row['mood_z_mean'], typ=row['typicality'],
                              p_real=row['p_real'], lufs=row['lufs'])), flush=True)
    with open(os.path.join(ROOT, 'music', 'listen.json'), 'w') as fh:
        json.dump(rows, fh, indent=1, default=str)


if __name__ == '__main__':
    main()
