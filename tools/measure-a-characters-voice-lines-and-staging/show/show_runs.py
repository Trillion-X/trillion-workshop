"""Show each high-pitch run from do-work/find_voice_by_pitch.py with the caption words spoken in it.
usage: python3 -I show/show_runs.py <voice.json> <json3>"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
from shared import events
r = json.load(open(sys.argv[1])); ev = events(sys.argv[2])
for x in r['hi_runs']:
    words = ' '.join(t for s, d, t in ev if s < x['end'] and s + max(d, 0.5) > x['start'])
    print(f"{x['start']:7.1f}-{x['end']:7.1f} {x['end']-x['start']:5.1f}s {x['f0_median']:5.0f}Hz  {words[:150]}")
