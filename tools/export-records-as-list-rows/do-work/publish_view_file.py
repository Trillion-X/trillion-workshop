#!/usr/bin/env python3
"""Publish the rows one saved view of a person's list shows into a file a site renders. The view is read first with
tools/read-a-list-view (one page holding the whole view: --limit at least its rows); its answer is this script's --read. A publish that
would write the same rows writes nothing.

Usage:
  node tools/read-a-list-view/do-work/read-list-view.mjs --config READ_CONFIG --view ID --limit N > READ
  python3 -I do-work/publish_view_file.py --read READ --config FILE --out FILE

The config holds `view` and optionally `media` (the keys at the top of read-data/view_publish.py); media folders in it are relative to
the config file's folder. Prints { file, rows, of, blake3, media: { copied, kept, not_public }, written }. Exit 0 published (or already
current), 2 when the config or the read could not be used, the read holds only part of the view, or a media file is missing.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))

import view_publish  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--read', required=True, type=Path, help="read-a-list-view's answer for the view")
    ap.add_argument('--config', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path, help='the file the site renders')
    a = ap.parse_args(argv)
    try:
        config = json.loads(a.config.read_text())
        read = json.loads(a.read.read_text())
        print(json.dumps(view_publish.publish(read, config, a.out, a.config.resolve().parent)))
        return 0
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as exc:
        print(f'Error: {exc!r}' if isinstance(exc, KeyError) else f'Error: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
