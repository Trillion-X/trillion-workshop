#!/usr/bin/env python3
"""Send the batches an export wrote, one at a time, through a command the person's config names.

Usage: python3 -I do-work/send_list_rows.py --config FILE [--key KEY] --batches DIR --status FILE [--only FAMILY ...]

The config is described at the top of read-data/send_batches.py. A re-run skips the batches the status file records as done.
Exit 0 when every batch was sent, 1 when one was refused (the status file says which and why), 2 when the config or a file could not be read.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))

import send_batches  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--config', required=True, type=Path)
    ap.add_argument('--key', help='the key of the config file that holds the settings (default: the whole file)')
    ap.add_argument('--batches', required=True, type=Path)
    ap.add_argument('--status', required=True, type=Path)
    ap.add_argument('--only', action='append', default=[])
    a = ap.parse_args(argv)
    try:
        config = json.loads(a.config.read_text())
        status = send_batches.run(config[a.key] if a.key else config, a.batches, a.status, a.only or None)
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as exc:
        print(f'Error: {exc!r}' if isinstance(exc, KeyError) else f'Error: {exc}', file=sys.stderr)
        return 2
    print(json.dumps(status, indent=1))
    return 0 if status['state'] == 'all_batches_sent' else 1


if __name__ == '__main__':
    raise SystemExit(main())
