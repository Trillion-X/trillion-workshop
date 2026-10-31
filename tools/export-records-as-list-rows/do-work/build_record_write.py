#!/usr/bin/env python3
"""Build the records a Trillion `records:write` takes from a person's records, by a mapping file. Sends nothing.

Writes one JSON file: the counts, what is pending or diverted, and `commands`, each { input: { records: [...] } } of at most 64 records
(the mapping's limit), to send in order. The mapping is described at the top of read-data/records_write.py.

Usage: python3 -I do-work/build_record_write.py --mapping FILE --out FILE [--root NAME=DIR ...]

`here` is always the folder of the mapping; every other folder a mapping names is given with --root NAME=DIR.
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))

import records_write  # noqa: E402
from record_write_send import Door  # noqa: E402


def named(text: str) -> tuple[str, Path]:
    name, sep, folder = text.partition('=')
    if not sep or not name or not folder:
        raise argparse.ArgumentTypeError(f'{text!r} is not NAME=DIR')
    return name, Path(folder)


def root_arguments(text: str) -> dict[str, Path]:
    """Parse the existing `--root NAME=DIR` input without a shell or command evaluation."""
    try:
        words = shlex.split(text)
    except ValueError as exc:
        raise ValueError(f'Roots are not valid quoted arguments: {exc}') from None
    roots: dict[str, Path] = {}
    index = 0
    while index < len(words):
        if words[index] != '--root' or index + 1 >= len(words):
            raise ValueError('Roots contain only --root NAME=DIR pairs.')
        name, folder = named(words[index + 1])
        roots[name] = folder
        index += 2
    return roots


def records_reader(roots: dict[str, Path], work: Path, url: str | None = None):
    """Open only the door config each records source declares; credentials remain in Door's keychain-backed memory."""
    doors: dict[Path, Door] = {}

    def read(source: dict) -> list[dict]:
        spec = source['records']
        ref = spec.get('config')
        if not isinstance(ref, dict) or not isinstance(ref.get('root'), str) or not isinstance(ref.get('path'), str):
            raise ValueError(f'{source.get("name", source["list"])} records source needs config {{root, path}}.')
        root = roots.get(ref['root'])
        if root is None:
            raise ValueError(f'No folder was given for root {ref["root"]}: give --root {ref["root"]}=DIR.')
        config_path = (root / ref['path']).resolve()
        if not config_path.is_relative_to(root.resolve()):
            raise ValueError(f'{source.get("name", source["list"])} door config must stay inside root {ref["root"]}.')
        if config_path not in doors:
            config = json.loads(config_path.read_text(encoding='utf-8'))
            if url is not None:
                if config.get('transport', {}).get('kind') != 'mcp':
                    raise ValueError('--records-url can override only an mcp transport.')
                config['transport']['url'] = url
            doors[config_path] = Door(config, work / f'door-{len(doors) + 1}', base=config_path.parent)
        door = doors[config_path]
        return door.read_type(spec['type'], spec.get('prefix'))

    return read


def run_records_reader(node: str, bridge: Path, records_door: Path, descriptor: int = 3):
    """Read through this run's fd capability. No sender config or personal account key is consulted in this mode."""
    # Keep the descriptor in memory. Each bridge gets a fresh anonymous stdin pipe;
    # neither a file nor an argument may hold the run capability.
    descriptor_bytes = bytearray()
    try:
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            descriptor_bytes.extend(chunk)
            if b'\n' in chunk:
                break
        if not descriptor_bytes:
            raise ValueError('This run did not hand the records builder a descriptor.')
    except OSError as exc:
        raise ValueError(f'Could not read this run\'s records descriptor ({type(exc).__name__}).') from None

    def read(source: dict) -> list[dict]:
        spec = source.get('records')
        record_type = spec.get('type') if isinstance(spec, dict) else None
        prefix = spec.get('prefix') if isinstance(spec, dict) else None
        name = source.get('name', source.get('list', 'records source'))
        if not isinstance(record_type, str) or not record_type:
            raise ValueError(f'{name} records source needs a non-empty type.')
        if prefix is not None and (not isinstance(prefix, str) or not prefix):
            raise ValueError(f'{name} records prefix, when given, is non-empty text.')
        args = [node, str(bridge), str(records_door), '0', record_type]
        if prefix is not None:
            args.append(prefix)
        try:
            result = subprocess.run(args, input=descriptor_bytes, capture_output=True, check=False)
        except OSError as exc:
            raise ValueError(f'{name} could not read through this run\'s records door ({type(exc).__name__}).') from None
        if result.returncode != 0:
            said = result.stderr.decode('utf-8', errors='replace').strip()
            raise ValueError(f'{name} could not read through this run\'s records door: {said[:400]}')
        try:
            records = json.loads(result.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError(f'{name} records door returned no JSON record list.') from None
        if not isinstance(records, list):
            raise ValueError(f'{name} records door returned no JSON record list.')
        return records
    return read


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--mapping', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--root', action='append', default=[], type=named, metavar='NAME=DIR')
    ap.add_argument('--roots-text', help='the existing `--root NAME=DIR` arguments as text; parsed as arguments, never a shell command')
    ap.add_argument('--records-url', help='another MCP address for records-source reads, such as a clone')
    ap.add_argument('--records-door-module', type=Path,
                    help='use the run-scoped records capability on descriptor 3 through this records-door module; never opens a sender config')
    ap.add_argument('--records-door-fd', type=int, default=3, help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    try:
        mapping = json.loads(a.mapping.read_text())
        roots = {'here': a.mapping.resolve().parent, **dict(a.root), **root_arguments(a.roots_text or '')}
        has_record_sources = any(source.get('kind') == 'records' for source in mapping.get('sources', []))
        if has_record_sources:
            if a.records_door_module is not None:
                bridge = Path(__file__).with_name('read_records_from_run_door.mjs')
                node = os.environ.get('TRILLION_NODE', 'node')
                payload = records_write.build(
                    mapping, roots,
                    record_reader=run_records_reader(node, bridge, a.records_door_module, a.records_door_fd))
            else:
                with tempfile.TemporaryDirectory(prefix='record-write-read-') as directory:
                    payload = records_write.build(mapping, roots,
                                                  record_reader=records_reader(roots, Path(directory), a.records_url))
        else:
            payload = records_write.build(mapping, roots)
        a.out.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + '\n')
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as exc:
        print(f'Error: {exc!r}' if isinstance(exc, KeyError) else f'Error: {exc}', file=sys.stderr)
        return 2
    print(json.dumps(payload['counts'], ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
