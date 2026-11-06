"""A made-up fact gate for the tests: passes when the claims file of the shot id it is given is a JSON object with "ok": true."""
import json
import sys
from pathlib import Path

lane = Path(sys.argv[sys.argv.index('--lane-dir') + 1])
sid = sys.argv[-1]
ok = json.loads((lane / 'claims' / f'{sid}.json').read_text()).get('ok') is True
print(f'{sid}: {"every claim sourced" if ok else "a claim has no source"}')
sys.exit(0 if ok else 1)
