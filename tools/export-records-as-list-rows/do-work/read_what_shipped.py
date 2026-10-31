#!/usr/bin/env python3
"""Add the newest release of a person's repository to a staged file, with the subjects of the commits since the release before it.
The settings are described at the top of read-data/what_shipped.py; the staged file is what build_record_write.py turns into rows.

Usage:
  python3 -I do-work/read_what_shipped.py --settings FILE --repository DIR --staged FILE

Prints { releases, added } (added is the new release's name, or null when the newest release was already there). Exit 0, or 2 when the
settings, the repository or the mark could not be read.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))

import what_shipped  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--settings', required=True, type=Path)
    ap.add_argument('--repository', required=True, type=Path)
    ap.add_argument('--staged', required=True, type=Path)
    a = ap.parse_args(argv)
    try:
        print(json.dumps(what_shipped.read(a.repository, json.loads(a.settings.read_text()), a.staged)))
        return 0
    except (ValueError, KeyError, OSError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
