#!/usr/bin/env python3
"""Run the existing sender's pure three-way refresh for its managed entry point. No files or network are read or written."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))
import record_write_send as sender


def main():
    try:
        given = json.load(sys.stdin)
        records, conflicts = sender.refresh_records(given['records'], given['baseline'], given['held'])
        json.dump({'records': records, 'conflicts': conflicts}, sys.stdout)
        return 0
    except (ValueError, KeyError, TypeError) as error:
        print(f'The source refresh was refused: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
