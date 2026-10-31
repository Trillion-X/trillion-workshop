#!/usr/bin/env python3
"""Freeze a root and every record and file it needs into one bundle file whose BLAKE3 is its identity, or refuse and say why.

The spec file is { tier, root, root_refs, resolutions, carried?, public_tiers? } as described at the top of
read-data/frozen_bundle.py: the caller reads the parts from the person's account and says what each ref resolves to.

Usage:
  python3 -I do-work/freeze_a_bundle.py --spec FILE --out FILE

Prints { ok, bundle_id, file, written, reference_issues, tier_issues }. The file is the bundle's canonical bytes, written only
when the closure is complete and tier-valid, and not again when it already holds those bytes. Exit 0 frozen (or already
frozen), 3 when a gate refused the closure (nothing is written), 2 when the spec could not be read.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))

import frozen_bundle  # noqa: E402
from record_write_send import blake3_hex  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--spec', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path, help='the bundle file to write')
    a = ap.parse_args(argv)
    try:
        frozen = frozen_bundle.freeze(json.loads(a.spec.read_text()))
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 2
    result = {'ok': frozen['ok'], 'bundle_id': None, 'file': str(a.out), 'written': False,
              'reference_issues': frozen['reference_issues'], 'tier_issues': frozen['tier_issues']}
    if not frozen['ok']:
        print(json.dumps(result))
        return 3
    data = frozen_bundle.canonical_bytes(frozen['bundle'])
    result['bundle_id'] = f'1f:{blake3_hex(data)}'
    if not (a.out.exists() and a.out.read_bytes() == data):
        a.out.write_bytes(data)
        result['written'] = True
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
