"""Print the character's detected turns (do-work/find_voice.py) with the caption words inside each.
usage: python3 -I show/show_turns.py <id.turns.json> <json3> [min_s]"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
from shared import events
r = json.load(open(sys.argv[1])); ev = events(sys.argv[2]); mn = float(sys.argv[3]) if len(sys.argv) > 3 else 0
for a, b in r['turns']:
    if b - a < mn: continue
    w = ' '.join(x for s, d, x in ev if s < b and s + max(d, 0.5) > a)
    print(f'{a:7.1f}-{b:7.1f} {b-a:5.1f}s {w[:170]}')
