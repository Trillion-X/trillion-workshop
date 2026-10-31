#!/usr/bin/env python3
"""Put a records:write payload (build_record_write.py's output) into a person's account through their door, writing only what the
account does not already hold; read it back; or copy every record of a type into a file first. The config is described at the top of
read-data/record_write_send.py.

Usage:
  python3 -I do-work/send_record_write.py --config FILE --work DIR [--url ADDRESS] [--key-prefix TEXT] plan --payload FILE
  python3 -I do-work/send_record_write.py --config FILE --work DIR send --payload FILE --status FILE
  python3 -I do-work/send_record_write.py --config FILE --work DIR readback --payload FILE
  python3 -I do-work/send_record_write.py --config FILE --work DIR export --type TYPE [--prefix ID_START] --out DIR

`send` prints one JSON line per command (records written, its request key, the local time) and the status at the end. Exit 0 when
everything was written (or a readback finds every record holding its value), 1 when a command was refused or a readback differs,
2 when the config, the payload or the door could not be read.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))

import record_write_send as sender  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--config', required=True, type=Path)
    ap.add_argument('--work', required=True, type=Path, help='a folder for the plan and result files of each call')
    ap.add_argument('--url', help='another address for an mcp transport (the same account served elsewhere, for example a copy)')
    ap.add_argument('--key-prefix', help='another start for every request key (one config shared by several loads, each with keys of its own)')
    ap.add_argument('--read-prefix', action='append', default=[], metavar='TYPE=PREFIX', help='bound reads of a type to a prefix; repeat for several prefixes; every target must be covered')
    sub = ap.add_subparsers(dest='command', required=True)
    for name in ('plan', 'send', 'readback'):
        one = sub.add_parser(name)
        one.add_argument('--payload', required=True, type=Path)
        one.add_argument('--baseline', type=Path, help='previous imported payload; refresh only source fields whose live value has not been edited')
        if name == 'send':
            one.add_argument('--status', required=True, type=Path)
    out = sub.add_parser('export')
    out.add_argument('--type', required=True)
    out.add_argument('--prefix')
    out.add_argument('--out', required=True, type=Path)
    a = ap.parse_args(argv)
    try:
        config = json.loads(a.config.read_text())
        if a.url:
            config['transport'] = {**config.get('transport', {}), 'url': a.url}
        if a.key_prefix:
            config['request_key_prefix'] = a.key_prefix
        if a.read_prefix:
            prefixes = {}
            for scope in a.read_prefix:
                kind, separator, prefix = scope.partition('=')
                if not separator or not kind or not prefix:
                    raise ValueError('--read-prefix is TYPE=PREFIX, each nonempty.')
                prefixes.setdefault(kind, []).append(prefix)
            config['read_prefixes'] = {**config.get('read_prefixes', {}), **prefixes}
        door = sender.Door(config, a.work, a.config.resolve().parent)
        if a.command == 'export':
            print(json.dumps(sender.export(door, a.type, a.out, a.prefix)))
            return 0
        payload = json.loads(a.payload.read_text())
        baseline = json.loads(a.baseline.read_text()) if a.baseline else None
        if a.command == 'plan':
            print(json.dumps(sender.plan(door, payload, baseline)))
            return 0
        if a.command == 'send':
            status = sender.send(door, payload, a.status, baseline=baseline)
            print(json.dumps({k: v for k, v in status.items() if k != 'done'}))
            return 0 if status['state'] == 'all_written' else 1
        result = sender.readback(door, payload, baseline)
        print(json.dumps({kind: ({**entry, 'missing': entry['missing'][:20], 'differing': entry['differing'][:20]} if kind != '_refresh' else entry) for kind, entry in result.items()}))
        return 0 if all(entry['equal'] == entry['payload'] for kind, entry in result.items() if kind != '_refresh') and not result.get('_refresh', {}).get('conflicts') else 1
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as exc:
        print(f'Error: {exc!r}' if isinstance(exc, KeyError) else f'Error: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
