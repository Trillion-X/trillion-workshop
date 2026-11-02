"""List every clip whose transcript names itself as a part of a numbered series.

usage: python3 -I series_parts.py <moments.jsonl> [<moments.jsonl> ...] [--within 300] [--out parts.tsv]

Each moments file holds one JSON row per spoken moment: `id` (`<clip>#<n>`, n orders the clip's moments), `text`, and
the clip's `identity` or `name`, `path` or `source_file`, and `source`. A clip qualifies when its joined moment text
says "part <n>" (a number, or one to fifteen in words) within its first --within characters (300 by default). Writes one
tab-separated line per clip: name, path, source, part words, and the clip's whole text, ordered by path, so each short
reads once. The lines go to --out, or to standard output ahead of the summary. The last line printed is
{"result": {...}} or {"error": "what to change"}.
"""
import argparse
import json
import re
import sys

PART = re.compile(r'\bpart\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\b', re.I)


class Refusal(Exception):
    pass


def read_clips(paths):
    clips = {}
    for path in paths:
        try:
            f = open(path, errors='replace')
        except OSError:
            raise Refusal(f'{path} is not there: pass moments files, one JSON row per moment')
        with f:
            for number, line in enumerate(f, 1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                    key = row.get('identity') or row['name']
                    moment = row['id']
                except (ValueError, KeyError, TypeError, AttributeError):
                    raise Refusal(f'{path} line {number} is not a moment row: each line is JSON with id, text and the clip\'s identity or name')
                where = row.get('path') or row.get('source_file', '')
                clip = clips.setdefault(key, {'name': row.get('name') or where.rsplit('/', 1)[-1], 'path': where,
                                             'source': row.get('source', ''), 'parts': []})
                tail = moment.rsplit('#', 1)[1] if '#' in moment else ''
                n = int(tail) if tail.isdigit() else 0
                clip['parts'].append((n, row.get('text', '')))
    return clips


def series_parts(clips, within=300):
    """(name, path, source, 'part <n>', whole text) for each clip that names its part early, ordered by path."""
    found = []
    for clip in sorted(clips.values(), key=lambda c: c['path']):
        text = ' '.join(t for _, t in sorted(clip['parts']))
        head = PART.search(text[:within])
        if head:
            found.append((clip['name'], clip['path'], clip['source'], f'part {head.group(1)}', text))
    return found


def main(argv):
    p = argparse.ArgumentParser(description='List clips that name themselves as a part of a series.')
    p.add_argument('moments', nargs='+')
    p.add_argument('--within', type=int, default=300)
    p.add_argument('--out')
    a = p.parse_args(argv)
    try:
        if a.within < 1:
            raise Refusal('--within must be 1 or more characters')
        clips = read_clips(a.moments)
    except Refusal as e:
        print(json.dumps({'error': str(e)}))
        return 2
    found = series_parts(clips, a.within)
    lines = ['\t'.join(f.replace('\t', ' ').replace('\n', ' ') for f in row) for row in found]
    if a.out:
        with open(a.out, 'w') as f:
            f.write(''.join(line + '\n' for line in lines))
    else:
        for line in lines:
            print(line)
    print(json.dumps({'result': {'clips': len(clips), 'series_parts': len(found), 'within': a.within, 'out': a.out}}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
