"""Print a YouTube json3 caption file as timed lines: one line per caption event, '>>' marks a speaker change.
usage: python3 -I show/show_lines.py <file.json3> [start_s] [end_s]"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
from shared import events

if __name__ == '__main__':
    a = float(sys.argv[2]) if len(sys.argv) > 2 else 0
    b = float(sys.argv[3]) if len(sys.argv) > 3 else 1e9
    for t, d, x in events(sys.argv[1]):
        if a <= t <= b:
            print(f'{t:7.1f} {x}')
