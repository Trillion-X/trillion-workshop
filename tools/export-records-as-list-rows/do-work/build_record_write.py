#!/usr/bin/env python3
"""Build the records a store's write takes from a person's records, by a mapping file. Sends nothing.

Writes one JSON file: the counts, what is pending or diverted, and `commands`, each { input: { records: [...] } } of at most 64 records
(the mapping's limit), to send in order. The mapping is described at the top of read-data/records_write.py.

Usage: python3 -I do-work/build_record_write.py --mapping FILE --out FILE [--root NAME=DIR ...]
       python3 -I do-work/build_record_write.py --mapping-record ID --records-from FILE ... --out FILE [--root ...]
       python3 -I do-work/build_record_write.py --mapping FILE --as-setting SCOPE_KIND~SCOPE_ID --setting-name TEXT --setting-from TEXT --out FILE

`here` is always the folder of the mapping file; every other folder a mapping names is given with --root NAME=DIR.

A person's own mapping is a setting row of their settings table (tools/settings), id
record:setting:export-records-as-list-rows~<scope_kind>~<scope_id>, its `settings` the mapping as text in its own key order (keys
and compute are worked out in order). A mapping too big for one command is kept in several rows: the first names the others in
`parts` and they add their sources after its own. --as-setting writes those rows (and the settings table) as a payload to send;
--mapping-record reads them back from files of rows the person's AI read from its store (--records-from, which also hold the mapping's lists_read and
records sources: this builder reads no account itself, the caller hands the records in).
"""
from __future__ import annotations

import argparse
import json
import shlex
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))

import records_write  # noqa: E402

FOLDER = 'export-records-as-list-rows'
TOOL = 'tool:build-records-to-write'


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


def settings_reader():
    """The shared reader of setting rows (tools/settings/read-data/settings.py), beside this tool's folder."""
    folder = Path(__file__).resolve().parents[2] / 'settings' / 'read-data'
    if not (folder / 'settings.py').is_file():
        raise ValueError(f'--mapping-record reads setting rows with tools/settings: it is not at {folder}.')
    if str(folder) not in sys.path:
        sys.path.insert(1, str(folder))
    import settings
    return settings


def held_records(files: list[Path]) -> list[dict]:
    """Every record of the saved files given (each { records } as the AI read it from the store, or a list of records)."""
    records: list[dict] = []
    for path in files:
        held = json.loads(path.read_text(encoding='utf-8'))
        held = held.get('records') if isinstance(held, dict) else held
        if not isinstance(held, list) or not all(isinstance(r, dict) and 'id' in r for r in held):
            raise ValueError(f'{path} holds no records: give the rows your AI read from the store ({{ "records": [...] }}).')
        records.extend(held)
    return records


def saved_reader(records: list[dict]):
    """A records reader over the saved reads handed in: the records of the source's type (and prefix)."""
    def read(source: dict) -> list[dict]:
        spec = source['records']
        prefix = spec.get('prefix') or ''
        return [r for r in records if r.get('type') == spec['type'] and r['id'].startswith(prefix)]
    return read


def setting_texts(mapping: dict) -> str:
    """A mapping as a setting's text: compact and in the mapping's own key order (keys and compute are worked out in order, and the
    account keeps an object's keys sorted, so the order lives only in the text)."""
    return json.dumps(mapping, ensure_ascii=False, separators=(',', ':'))


def mapping_setting_records(mapping: dict, scope_kind: str, scope_id: str, *, name: str, source: str, most: int) -> list[dict]:
    """The setting rows that keep a mapping: one row, or, when its record would not fit a command of `most` bytes, a first row
    naming the later ones in `parts`, its sources cut between the rows in order (every other key stays on the first)."""
    settings = settings_reader()

    def record(part_id: str, value: dict) -> dict:
        made = settings.make_record(FOLDER, scope_kind, part_id, {}, name=name, tool=TOOL, source=source)
        made['value']['settings'] = setting_texts(value)
        return made

    def size(made: dict) -> int:
        return len(json.dumps({'records': [made]}, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))

    whole = record(scope_id, mapping)
    if size(whole) <= most:
        return [whole]
    head = {k: v for k, v in mapping.items() if k != 'sources'}
    groups: list[list[dict]] = [[]]
    for source_ in mapping.get('sources', []):
        trial = groups[-1] + [source_]
        first = len(groups) == 1
        value = {**head, 'parts': ['x' * 120] * 8, 'sources': trial} if first else {'sources': trial}
        if groups[-1] and size(record(f'{scope_id}.part-{len(groups) + 1}', value)) > most:
            groups.append([source_])
        else:
            groups[-1] = trial
    ids = [f'{scope_id}.part-{n}' for n in range(2, len(groups) + 1)]
    made = [record(scope_id, {**head, 'parts': [settings.setting_id(FOLDER, scope_kind, i) for i in ids], 'sources': groups[0]})]
    made += [record(i, {'sources': group}) for i, group in zip(ids, groups[1:])]
    for one in made:
        if size(one) > most:
            raise ValueError(f'{one["id"]} needs {size(one)} bytes, more than a command takes ({most}): one source alone is too big.')
    return made


def mapping_from_record(record_id: str, saved: list[dict] | None) -> dict:
    """The mapping a person keeps as setting rows of the settings table (tools/settings): the row's `settings` is the mapping, and the
    rows its `parts` names add their sources after its own, in order. Read from the saved reads (--records-from) the caller gave."""
    settings = settings_reader()
    folder, _, _ = settings.parse_id(record_id)
    if folder != FOLDER:
        raise ValueError(f'{record_id} is a setting of {folder}, not of {FOLDER}.')
    if saved is None:
        raise ValueError('--mapping-record is read from the records the caller hands in: give --records-from.')

    def one(wanted: str) -> dict:
        held = [r for r in saved if r.get('type') == settings.RECORD_TYPE]
        found = next((record for record in held if record.get('id') == wanted), None)
        if found is None:
            raise ValueError(f'The records handed in hold no setting {wanted}.')
        value = settings.settings_of(found, TOOL)
        if not isinstance(value, dict) or not isinstance(value.get('sources'), list):
            raise ValueError(f'{wanted} holds no mapping: its settings are an object with sources.')
        return value

    mapping = one(record_id)
    for part in mapping.pop('parts', []):
        mapping['sources'] = [*mapping['sources'], *one(part)['sources']]
    return mapping


def write_setting(a) -> int:
    """--as-setting: the payload (the shape `build` writes) of the settings table and the setting rows that keep the --mapping."""
    if a.mapping is None or not a.setting_name or not a.setting_from:
        raise ValueError('--as-setting writes the rows of a --mapping file: give --setting-name and --setting-from too.')
    scope_kind, sep, scope_id = a.as_setting.partition('~')
    if not sep:
        raise ValueError(f'--as-setting {a.as_setting!r} is not SCOPE_KIND~SCOPE_ID.')
    mapping = json.loads(a.mapping.read_text(encoding='utf-8'))
    rows = mapping_setting_records(mapping, scope_kind, scope_id, name=a.setting_name, source=a.setting_from, most=a.command_bytes)
    records = rows
    commands = records_write.commands_of(records, {'per_command': 64, 'command_bytes': a.command_bytes})
    payload = {'_what': f'The setting rows of the settings table that keep the mapping {a.setting_name!r} ({len(rows)} rows).',
               'built_at': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
               'counts': {'records': len(records), 'commands': len(commands), 'views': 0, 'rows': {'settings': len(rows)}},
               'pending': [], 'commands': commands}
    a.out.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps(payload['counts'], ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    which = ap.add_mutually_exclusive_group(required=True)
    which.add_argument('--mapping', type=Path)
    which.add_argument('--mapping-record', metavar='ID',
                       help='read the mapping from this setting row (record:setting:export-records-as-list-rows~<scope_kind>~<scope_id>)')
    ap.add_argument('--records-from', action='append', default=[], type=Path, metavar='FILE',
                    help='files of rows your AI read from the store: the mapping record, lists and records sources are read from them')
    ap.add_argument('--as-setting', metavar='SCOPE_KIND~SCOPE_ID',
                    help='with --mapping: write the setting rows that keep this mapping in the settings table, to send instead of building')
    ap.add_argument('--setting-name', help='with --as-setting: what the mapping makes, in a few words')
    ap.add_argument('--setting-from', help='with --as-setting: where the mapping came from, "<old path>@<sha>"')
    ap.add_argument('--command-bytes', type=int, default=49152, help='with --as-setting: the most bytes one command takes')
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--root', action='append', default=[], type=named, metavar='NAME=DIR')
    ap.add_argument('--roots-text', help='the existing `--root NAME=DIR` arguments as text; parsed as arguments, never a shell command')
    a = ap.parse_args(argv)
    try:
        if a.as_setting is not None:
            return write_setting(a)
        saved = held_records(a.records_from) if a.records_from else None
        if a.mapping is not None:
            mapping = json.loads(a.mapping.read_text())
            roots = {'here': a.mapping.resolve().parent, **dict(a.root), **root_arguments(a.roots_text or '')}
        else:
            mapping = mapping_from_record(a.mapping_record, saved)
            roots = {**dict(a.root), **root_arguments(a.roots_text or '')}
        has_record_sources = 'lists_read' in mapping or any(source.get('kind') == 'records' for source in mapping.get('sources', []))
        if has_record_sources:
            if saved is None:
                raise ValueError('The mapping reads records (a lists_read or a records source): the caller hands them in with --records-from.')
            payload = records_write.build(mapping, roots, record_reader=saved_reader(saved))
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
