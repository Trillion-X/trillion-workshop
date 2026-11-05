"""Listen to every music excerpt with earshot (models load once).

For each excerpt from find_music_windows.py (OUT/music/windows.json): per-section mood match against the film's own section words,
typicality against a reference music stem cut into its sections, realness, and the top describe tags. The words, the alternatives and
the reference are the person's BRIEF.json: {sections: [{name, start, end, query}], alts: [...], reference: {stem, sections: [[from, to], ...]}}.
Writes OUT/music/listen.json; the last line printed is {"result": {...}}. Usage: <earshot venv python> -I listen_to_music_windows.py BRIEF.json OUT
"""
import json
import os
import pathlib
import subprocess
import sys

from earshot import api

ROOT = None   # OUT (argv): find_music_windows.py's folder
STEM = None   # the reference stem (BRIEF.json)
REF_SECTIONS = SECTIONS = ALTS = None   # the reference's sections, the film's sections and words, the alternatives (BRIEF.json)


def ref_dir():
    d = os.path.join(ROOT, 'music', 'ref-sections')
    os.makedirs(d, exist_ok=True)
    for i, (a, b) in enumerate(REF_SECTIONS):
        out = os.path.join(d, f'reference-section{i + 1}_{a:g}-{b:g}.wav')
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
    with open(sys.argv[1]) as fh:
        brief = json.load(fh)
    SECTIONS, ALTS = [dict(s) for s in brief['sections']], brief['alts']
    STEM, REF_SECTIONS = brief['reference']['stem'], [tuple(r) for r in brief['reference']['sections']]
    ROOT = sys.argv[2]
    main()
    print(json.dumps({'result': {'listen': os.path.join(ROOT, 'music', 'listen.json')}}))
