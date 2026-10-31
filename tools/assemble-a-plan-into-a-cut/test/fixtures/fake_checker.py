"""A stand-in check for the tests: says one line about a file and exits with the code it is given.

usage: python3 fake_checker.py <exit code> <line to print> <file> [<report.json>]

Refuses (exit 9) when the file is not there, so a check that is handed the wrong file shows.
"""
import json
import os
import sys

code, line, path = int(sys.argv[1]), sys.argv[2], sys.argv[3]
if not os.path.exists(path):
    print(f'no such file {path}')
    sys.exit(9)
print(line)
if len(sys.argv) > 4:
    with open(sys.argv[4], 'w') as f:
        json.dump({'file': path, 'said': line}, f)
sys.exit(code)
