"""List every clip whose transcript names itself as a part of a numbered series.

usage: /opt/homebrew/anaconda3/bin/python3 -I series_parts.py <moments.jsonl> [<moments.jsonl> ...]

A clip qualifies when its joined moment text says "part <n>" within its first
300 characters. Prints one line per clip: name, path, source, part words, and
the clip's whole text, ordered by path, so each short reads once.
"""
import json
import re
import sys

PART = re.compile(r'\bpart\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\b', re.I)


def main():
    clips = {}
    for path in sys.argv[1:]:
        with open(path, errors='replace') as f:
            for line in f:
                row = json.loads(line)
                key = row.get('identity') or row['name']
                where = row.get('path') or row.get('source_file', '')
                clip = clips.setdefault(key, {'name': row.get('name') or where.rsplit('/', 1)[-1], 'path': where,
                                             'source': row.get('source', ''), 'parts': []})
                n = int(row['id'].rsplit('#', 1)[1]) if '#' in row['id'] else 0
                clip['parts'].append((n, row.get('text', '')))
    for clip in sorted(clips.values(), key=lambda c: c['path']):
        text = ' '.join(t for _, t in sorted(clip['parts']))
        head = PART.search(text[:300])
        if head:
            print(f"{clip['name']}\t{clip['path']}\t{clip['source']}\tpart {head.group(1)}\t{text}")


main()
