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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--mapping', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--root', action='append', default=[], type=named, metavar='NAME=DIR')
    ap.add_argument('--records-url', help='another MCP address for records-source reads, such as a clone')
    a = ap.parse_args(argv)
    try:
        mapping = json.loads(a.mapping.read_text())
        roots = {'here': a.mapping.resolve().parent, **dict(a.root)}
        has_record_sources = any(source.get('kind') == 'records' for source in mapping.get('sources', []))
        if has_record_sources:
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
