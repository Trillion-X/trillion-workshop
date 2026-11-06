#!/usr/bin/env python3
"""A stand-in content gate for the publish tests: logs its argv to GATE_LOG and passes, or, with GATE_FAILS set, fails the way
a checklist gate does (exit 1, its JSON naming the unanswered rows). Made up."""
import json
import os
import sys

if os.environ.get('GATE_LOG'):
    with open(os.environ['GATE_LOG'], 'a') as fh:
        fh.write(json.dumps(sys.argv[1:]) + '\n')
if os.environ.get('GATE_FAILS'):
    print(json.dumps({'unanswered_must': [{'id': 'made-up-row-1'}], 'failed_must': [], 'problems': []}))
    raise SystemExit(1)
print(json.dumps({'ok': True}))
