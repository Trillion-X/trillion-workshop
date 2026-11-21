"""One person's tool settings, read the way old Trillion's decision store read a `setting` record.

A setting is a row of the person's settings table (the owner-places role `settings`, made by settings-store.mjs): record type `record:setting`, id
`record:setting:<workshop-folder>~<scope_kind>~<scope_id>`, fields name, tool, scope_kind (person, film, piece or
account), scope_id, settings (JSON, as text or as an object), from ("<old path>@<sha>") and status.

A tool takes `settings_record` in its request: the record as the person's store gives it ({id, type, value}), its
value alone, a list of such records, or the path of a JSON file holding any of those; or a row id, looked up in the
rows handed in `stored.records`; or, left out, the setting rows in `stored.records`. `setting()` picks the most specific
scope asked for and gives its settings, or the defaults (None) when there is none: the same answer old Trillion's
`setting(name)` gave (src/decision-store.mjs before 4ffa1dc4a2, lines 751-753).

Standard library only.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Iterable

SETTINGS_ROLE = 'settings'
RECORD_TYPE = 'record:setting'
ID_PREFIX = 'record:setting:'
SCOPE_KINDS = ('piece', 'film', 'person', 'account')
STATUSES = ('active', 'retired')


class SettingError(ValueError):
    """A settings record that cannot be read; the message says how to fix the request."""


def setting_id(folder: str, scope_kind: str, scope_id: str) -> str:
    if not folder or '~' in folder or '/' in folder:
        raise SettingError(f'{folder!r} is not a Workshop folder name: give the folder under tools/, without ~ or /.')
    if scope_kind not in SCOPE_KINDS:
        raise SettingError(f'scope_kind {scope_kind!r} is not one of {", ".join(SCOPE_KINDS)}.')
    if not scope_id:
        raise SettingError('scope_id is empty: name the person, film, piece or account the settings are for.')
    return f'{ID_PREFIX}{folder}~{scope_kind}~{scope_id}'


def parse_id(record_id: str) -> tuple[str, str, str]:
    if not isinstance(record_id, str) or not record_id.startswith(ID_PREFIX):
        raise SettingError(f'{record_id!r} is not a setting id: it starts with {ID_PREFIX}.')
    parts = record_id[len(ID_PREFIX):].split('~', 2)
    if len(parts) != 3 or parts[1] not in SCOPE_KINDS or not parts[0] or not parts[2]:
        raise SettingError(f'{record_id!r} is not {ID_PREFIX}<workshop-folder>~<scope_kind>~<scope_id>.')
    return parts[0], parts[1], parts[2]


def make_record(folder: str, scope_kind: str, scope_id: str, settings: Any, *, name: str, tool: str,
                source: str, status: str = 'active') -> dict:
    """The record kept for one setting row. `settings` is kept as JSON text, sorted keys."""
    if status not in STATUSES:
        raise SettingError(f'status {status!r} is not one of {", ".join(STATUSES)}.')
    return {
        'id': setting_id(folder, scope_kind, scope_id),
        'type': RECORD_TYPE,
        'value': {
            'name': name,
            'tool': tool,
            'scope_kind': scope_kind,
            'scope_id': scope_id,
            'settings': json.dumps(settings, ensure_ascii=False, sort_keys=True, separators=(',', ':')),
            'from': source,
            'status': status,
        },
    }


def _records(given: Any) -> list[dict]:
    if given is None:
        return []
    if isinstance(given, (str, Path)):
        path = Path(given)
        try:
            given = json.loads(path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            raise SettingError(f"settings_record names {str(path)!r}, which does not exist: give the file of rows read from the person's store, or the record itself.") from None
        except json.JSONDecodeError as exc:
            raise SettingError(f"{str(path)!r} is not JSON ({exc}): give the record the person's store gave.") from None
    if isinstance(given, dict) and isinstance(given.get('records'), list):
        given = given['records']
    if isinstance(given, dict):
        given = [given]
    if not isinstance(given, list) or not all(isinstance(item, dict) for item in given):
        raise SettingError('settings_record is a record ({id, type, value}), its value, a list of them, or a JSON file of them.')
    return given


def _value(record: dict) -> tuple[str | None, dict]:
    if 'value' in record and isinstance(record['value'], dict):
        kind = record.get('type')
        if kind not in (None, RECORD_TYPE):
            raise SettingError(f'{record.get("id")!r} is a {kind!r}, not a {RECORD_TYPE}.')
        return record.get('id'), record['value']
    return record.get('id'), record


def settings_of(record: dict, tool: str | None = None) -> Any:
    """The settings one record holds, parsed. Refuses a retired record or one written for another tool."""
    record_id, value = _value(record)
    if value.get('status', 'active') != 'active':
        raise SettingError(f'{record_id or value.get("name")!r} is {value.get("status")!r}: read the active row that replaced it.')
    if tool and value.get('tool') and value['tool'] != tool:
        raise SettingError(f'{record_id!r} holds settings for {value["tool"]}, not {tool}.')
    held = value.get('settings')
    if isinstance(held, str):
        try:
            return json.loads(held)
        except json.JSONDecodeError as exc:
            raise SettingError(f'{record_id!r}: its settings field is not JSON ({exc}).') from None
    return held


def _scope(record: dict) -> tuple[str | None, str | None, str | None]:
    record_id, value = _value(record)
    if record_id:
        return parse_id(record_id)
    return None, value.get('scope_kind'), value.get('scope_id')


def setting(given: Any, folder: str | None = None, scopes: Iterable[tuple[str, str]] | None = None,
            default: Any = None, tool: str | None = None) -> Any:
    """The settings for `folder` at the first of `scopes` (most specific first) that has a row, else `default`.

    With no scopes, a single record given is read as it is (the caller already chose it)."""
    found = chosen(given, folder, scopes)
    return default if found is None else settings_of(found, tool)


def chosen(given: Any, folder: str | None = None, scopes: Iterable[tuple[str, str]] | None = None) -> dict | None:
    records = _records(given)
    if folder:
        records = [r for r in records if _scope(r)[0] in (None, folder)]
    if not records:
        return None
    if scopes is None:
        if len(records) > 1:
            raise SettingError(f'{len(records)} settings records were given and no scope: say which person, film, piece or account.')
        return records[0]
    for kind, scope_id in scopes:
        for record in records:
            if _scope(record)[1:] == (kind, scope_id):
                return record
    return None


# --- The settings a program runs with: its defaults, the row it is handed, then its own settings ---

def lay_over(under: Any, over: Any) -> Any:
    """Plain objects merge key by key; anything else is replaced whole (settings.mjs layOver)."""
    if not isinstance(under, dict) or not isinstance(over, dict):
        return under if over is None else over
    out = dict(under)
    for key, value in over.items():
        out[key] = lay_over(under[key], value) if key in under else value
    return out


def _is_setting_row(record: Any) -> bool:
    return isinstance(record, dict) and record.get('type', RECORD_TYPE) == RECORD_TYPE


def _handed_records(stored: Any) -> list[dict] | None:
    """The rows handed in `stored.records`, or None when no rows were handed."""
    if stored is None:
        return None
    if not isinstance(stored, dict) or not isinstance(stored.get('records'), list):
        raise SettingError('stored, when given, is {"records": [{id, type, value}, ...]}: the rows read from the person\'s store.')
    return stored['records']


def handed_record(stored: Any, record_id: str, folder: str | None = None) -> dict | None:
    """The row `record_id` names among the rows handed in `stored.records` (settings.mjs handedRecord), or None when
    none was handed or its value is null. With `folder`, a row of another tool's folder is refused."""
    row_folder = parse_id(record_id)[0]
    if folder and row_folder != folder:
        raise SettingError(f'{record_id!r} belongs to tools/{row_folder}, not tools/{folder}: give a {ID_PREFIX}{folder}~... id.')
    for record in _handed_records(stored) or []:
        if _is_setting_row(record) and record.get('id') == record_id and isinstance(record.get('value'), dict):
            return {'id': record_id, 'type': RECORD_TYPE, 'value': record['value']}
    return None


def given_rows(request: dict, folder: str | None = None) -> Any:
    """What `settings_record` gives: a row id is looked up in `stored.records`; left out, the rows in `stored.records`."""
    given = request.get('settings_record')
    handed = _handed_records(request.get('stored'))
    if isinstance(given, str) and given.startswith(ID_PREFIX):
        if handed is None:
            raise SettingError(f'settings_record names {given}, but no rows were handed in: read it from the settings table '
                               f"(owner-places role {SETTINGS_ROLE}) in the person's store and hand it in stored.records, or hand the record itself.")
        record = handed_record(request['stored'], given, folder)
        if record is None:
            raise SettingError(f'No {given} in the settings table: write the row first, or leave settings_record out to run on the defaults.')
        return record
    if given is None and handed is not None:
        return [r for r in handed if _is_setting_row(r) and isinstance(r.get('value'), dict)]
    return given


def request_settings(request: dict, defaults: Any, folder: str | None = None,
                     scopes: Iterable[tuple[str, str]] | None = None, tool: str | None = None) -> Any:
    """Weakest first: `defaults`, the row `request['settings_record']` gives (given_rows: a record, its value, a list
    or a file, as setting() takes, or a row id looked up in `request['stored']`), then `request['settings']`."""
    given = given_rows(request, folder)
    found = None if given is None else chosen(given, folder, scopes)
    out = copy.deepcopy(defaults)
    if found is not None:
        out = lay_over(out, settings_of(found, tool))
    own = request.get('settings')
    if own is not None:
        if not isinstance(own, dict):
            raise SettingError('settings, when given, must be a JSON object.')
        out = lay_over(out, own)
    return out


def keep(records: Iterable[dict], stored: Any) -> list[dict]:
    """The rows to keep in the person's store, each with `expected`: the row as handed in `stored.records`
    ({type, value}), or None when it was not there. A store refuses a keep whose expected row has moved, so a
    write made from a stale read never lands."""
    handed = {r.get('id'): r for r in _handed_records(stored) or [] if isinstance(r, dict)}
    out = []
    for record in records:
        before = handed.get(record['id'])
        expected = None if before is None or before.get('value') is None else {'type': before.get('type'), 'value': before['value']}
        out.append({**record, 'expected': expected})
    return out
