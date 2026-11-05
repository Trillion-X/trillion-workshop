"""check-a-rendered-video inspect eyes <landmarks.json> [--lowest N]

The eye openness (the lower of the two eyes) and mouth openness of every picture vision_landmarks.py read, sorted: the lowest N, the median
and the 10th percentile, the numbers a held_face.eye_open_min limit is chosen from. The table a person reads goes to standard error; the last
line on standard output is {"result": {"pictures", "with_a_face", "lowest", "all_eye_open", "median", "p10"}}."""
import argparse
import contextlib
import json
import os
import sys


def eye_table(path, lowest):
    """Sorted eye openness (min of the two eyes) of the largest face in each picture, as held-face reads it."""
    d = json.load(open(path))
    rows = sorted((min(e for e in f['eye_open'] if e is not None), p[-8:-4], round(f['mouth_open'] or 0, 2)) for p, fs in d.items() for f in fs[:1] if any(e is not None for e in f['eye_open']))
    print(len(rows), 'frames with a face of', len(d))
    print([(round(a, 3), b, m) for a, b, m in rows[:14]])
    if rows:
        print('median', round(rows[len(rows) // 2][0], 3), 'p10', round(rows[len(rows) // 10][0], 3))
    full = sorted((min(e for e in f['eye_open'] if e is not None), os.path.basename(p), f.get('mouth_open')) for p, fs in d.items() for f in fs[:1] if any(e is not None for e in f['eye_open']))
    values = [round(e, 3) for e, _, _ in full]
    return {'pictures': len(d), 'with_a_face': len(full), 'all_eye_open': values,
            'lowest': [{'picture': p, 'eye_open': round(e, 3), 'mouth_open': None if m is None else round(m, 3)} for e, p, m in full[:lowest]],
            'median': values[len(values) // 2] if values else None, 'p10': values[len(values) // 10] if values else None}


def main(argv):
    ap = argparse.ArgumentParser(prog='check-a-rendered-video inspect eyes', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('landmarks', help='the JSON vision_landmarks.py printed: {picture: [{eye_open, mouth_open}]}')
    ap.add_argument('--lowest', type=int, default=14)
    a = ap.parse_args(argv)
    with contextlib.redirect_stdout(sys.stderr):
        result = eye_table(a.landmarks, a.lowest)
    print(json.dumps({'result': result}))
    return 0
