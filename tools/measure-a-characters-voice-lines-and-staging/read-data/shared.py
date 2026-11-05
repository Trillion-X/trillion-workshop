"""Print a YouTube json3 caption file as timed lines: one line per caption event, '>>' marks a speaker change.
usage: python3 -I lines.py <file.json3> [start_s] [end_s]"""
import json, sys

def events(path):
    d = json.load(open(path, encoding='utf-8'))
    out = []
    for e in d.get('events', []):
        segs = e.get('segs')
        if not segs:
            continue
        t = ''.join(s.get('utf8', '') for s in segs).replace('\n', ' ').strip()
        if t:
            out.append((e.get('tStartMs', 0) / 1000.0, e.get('dDurationMs', 0) / 1000.0, t))
    return out
