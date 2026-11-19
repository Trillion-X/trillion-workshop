#!/usr/bin/env python3
"""Plan the writes that put a builder payload into a person's store, or check the store after they are written.

The input is one JSON object on standard input, described at the top of read-data/record_write_plan.py: the builder's payload, the
target type and prefix, the target records the store holds now (`held`), the config and an optional baseline. Nothing is read from or
written to any store; the caller writes each command into its own store and hands the target records back for `readback`.

Usage:
  python3 -I do-work/plan_record_write.py plan < input.json
  python3 -I do-work/plan_record_write.py readback < input.json

`plan` prints { state, records, to_write, commands, out_of_scope, conflicts? }. `readback` prints { state, records, readback, out_of_scope,
conflicts }. Exit 0 for a plan, or for a readback that is all_equal; 1 when a readback differs; 2 when the input could not be read.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))

import record_write_plan  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('mode', choices=('plan', 'readback'))
    a = ap.parse_args(argv)
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise ValueError('The input is one JSON object.')
        answer = record_write_plan.plan(request) if a.mode == 'plan' else record_write_plan.readback(request)
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(f'Error: {exc!r}' if isinstance(exc, KeyError) else f'Error: {exc}', file=sys.stderr)
        return 2
    print(json.dumps(answer, ensure_ascii=False))
    if a.mode == 'plan':
        return 0
    return 0 if answer['state'] == 'all_equal' else 1


if __name__ == '__main__':
    raise SystemExit(main())
