"""Every named input this repository's live code reads from the place running it, with the files that read it.

  python3 tools/list-a-repositorys-place-inputs/read-data/list_inputs.py            # markdown table; --root selects the repository
  python3 tools/list-a-repositorys-place-inputs/read-data/list_inputs.py --missing  # only the place inputs not set here, so a place can see what it lacks

Read: os.environ[...] / .get(...), process.env.X, placeReports('X'), place.reported('X') and ${X:?...}. Frozen run records
and tests are not read. Run switches (set by one run, not by the place) are listed apart.
"""
import collections
import os
import re
import subprocess
import sys
from pathlib import Path

CHECKOUT = Path(__file__).resolve().parents[3]
PATTERN = re.compile(r"""environ(?:\.get)?[\[\(]\s*['"]([A-Z][A-Z0-9_]+)['"]|process\.env\.([A-Z][A-Z0-9_]+)"""
                     r"""|placeReports\(\s*['"]([A-Z][A-Z0-9_]+)['"]|reported\(\s*['"]([A-Z][A-Z0-9_]+)['"]|\$\{([A-Z][A-Z0-9_]+):\?""")
NOT_INPUTS = {'PATH', 'HOME', 'USERPROFILE', 'PYTHONPATH', 'TMPDIR', 'PWD', 'USER', 'CI', 'TERM', 'LANG', 'NODE_ENV', 'DEBUG', 'NODE_TEST_CONTEXT'}
RUN_SWITCHES = {'COPY_GATE_UNDER_TEST', 'COPY_GATE_VERDICTS', 'FILM_RENDER_LOCK_HELD', 'PICK_GATE_FILM', 'PICK_GATE_LABELS_OUT',
                'FACT_GATE_LANE_DIR', 'BOOK_VOICE_EVAL_CONCURRENCY', 'WHISPER_BACKEND', 'WHISPER_DEVICE', 'FILMCRAFT_OPT', 'MASTERED'}
EXCLUDE = [':!admission', ':!**/before*/**', ':!**/preserved-prior*/**', ':!tools/copy-gate/book-voice/**', ':!**/tests/**',
           ':!**/test_*.py', ':!**/*.test.mjs', ':!tools/list-a-repositorys-place-inputs/read-data/list_inputs.py']


def inputs(checkout=CHECKOUT):
    files = subprocess.run(['git', '-C', str(checkout), 'ls-files', '--', '*.py', '*.sh', '*.mjs', '*.js', '*.cjs', *EXCLUDE],
                           capture_output=True, text=True, check=True).stdout.splitlines()
    by = collections.defaultdict(set)
    for f in files:
        try:
            text = (checkout / f).read_text(errors='ignore')
        except OSError:
            continue
        for m in PATTERN.finditer(text):
            name = next(g for g in m.groups() if g)
            if name not in NOT_INPUTS:
                by[name].add(f)
    return by


def where(files):
    tops = sorted({'/'.join(f.split('/')[:2]) for f in files})
    return ', '.join(f'`{t}`' for t in tops[:6]) + (' …' if len(tops) > 6 else '')


def main(argv):
    import argparse
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=CHECKOUT)
    parser.add_argument("--missing", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    by = inputs(args.root.resolve(strict=True))
    place = {n: f for n, f in by.items() if n not in RUN_SWITCHES}
    if args.json:
        rows = [{"name": n, "files": sorted(f), "run_switch": n in RUN_SWITCHES,
                 "set": bool(os.environ.get(n))} for n, f in sorted(by.items())
                if not args.missing or (n not in RUN_SWITCHES and not os.environ.get(n))]
        print(json.dumps({"inputs": rows}))
        return 0
    if args.missing:
        for n in sorted(place):
            if not os.environ.get(n):
                print(f'{n}\t{where(place[n])}')
        return 0
    print('| Input | Files | Read in |\n|---|---|---|')
    for n in sorted(place):
        print(f'| `{n}` | {len(place[n])} | {where(place[n])} |')
    print('\nRun switches, set by one run and not by the place: ' + ', '.join(f'`{n}`' for n in sorted(set(by) & RUN_SWITCHES)) + '.')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
