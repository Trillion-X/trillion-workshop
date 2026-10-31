"""A made-up derived-file check: data/crop-count.txt must equal the number of crops. Exit 0 current, 1 stale (names it), 3 when it cannot tell."""
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
crops = json.loads((root / 'data' / 'crops.json').read_text())['crops']
try:
    written = int((root / 'data' / 'crop-count.txt').read_text())
except ValueError:
    print('crop-count.txt does not hold a number', file=sys.stderr)
    raise SystemExit(3)
if written == len(crops):
    raise SystemExit(0)
print(json.dumps({'stale': ['crop-count.txt']}))
raise SystemExit(1)
