#!/usr/bin/env python3
"""Turn a library's records into Trillion put_list_rows payloads by a mapping file. Sends nothing.

Writes make_lists.json, the row batches (<source>-000.json, ...) and manifest.json into --out. Row ids are stable, so loading the same
payload twice updates rows. Rows whose id is in --skip-ids (a JSON file: {"<list id>": ["<row id>", ...]}) are left out so existing
rows are never overwritten. The mapping is described at the top of read-data/list_rows.py.

Usage: python3 -I do-work/export_records_as_list_rows.py --mapping FILE --out DIR --root DIR [--batch 100] [--only SOURCE] [--skip-ids FILE]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))

import list_rows  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--mapping', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path, help='the folder to write the payloads into')
    ap.add_argument('--root', required=True, type=Path, help='the folder the mapping\'s files and globs are relative to')
    ap.add_argument('--batch', type=int, default=100)
    ap.add_argument('--only', help='export this source alone')
    ap.add_argument('--skip-ids', type=Path)
    a = ap.parse_args(argv)
    try:
        mapping = json.loads(a.mapping.read_text())
        root = a.root
        skip = json.loads(a.skip_ids.read_text()) if a.skip_ids else {}
        if a.batch < 1:
            raise ValueError('--batch must be at least 1')
        manifest = list_rows.export(mapping, root, a.out, a.batch, a.only, skip)
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 2
    print(json.dumps(manifest['counts'], indent=1))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
