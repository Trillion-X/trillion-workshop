"""check-a-rendered-video inspect placement <findings.json> [...]

Per video of --json findings files (of check or batch runs), placement's per-box heat (None: over a cover, not judged) and exit heat, or its
FAIL row. The lines a person reads go to standard error; the last line on standard output is {"result": {"rows": [...]}}."""
import argparse
import contextlib
import json
import sys


def placement_rows(files):
    """Per-box placement numbers with exit windows from --json findings files."""
    out = []
    for f in files:
        for key, checks in json.load(open(f)).items():
            if key in ('_film_qa', '_run'):      # the run record of film-qa or of the Workshop's check-a-rendered-video
                continue
            for r in checks.get('placement', []):
                d = r.get('data') or {}
                if 'boxes' in d:
                    print(f.split('pl-')[-1], {i: (None if b['heat'] is None else (round(b['heat'], 2), 'exit', round(b['exit']['heat'], 2) if b.get('exit') else None)) for i, b in d['boxes'].items()})
                    out.append({'file': f, 'video': key, 'boxes': {i: {'heat': None if b['heat'] is None else round(b['heat'], 2),
                                                                        'exit_heat': round(b['exit']['heat'], 2) if b.get('exit') else None} for i, b in d['boxes'].items()}})
                elif 'id' in d:
                    print(f.split('pl-')[-1], 'FAIL', d['id'], round(d['heat'], 2), d['frames'], 'frames')
                    out.append({'file': f, 'video': key, 'status': r['status'], 'id': d['id'], 'heat': round(d['heat'], 2), 'frames': d.get('frames')})
    return {'rows': out}


def main(argv):
    ap = argparse.ArgumentParser(prog='check-a-rendered-video inspect placement', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('findings', nargs='+', help='--json files of check or batch runs')
    a = ap.parse_args(argv)
    with contextlib.redirect_stdout(sys.stderr):
        result = placement_rows(a.findings)
    print(json.dumps({'result': result}, default=str))
    return 0
