"""Read a tool's settings from the person's `list:settings` row: the one reader every Workshop tool shares.

A setting is one record of type `record:setting` with the id `record:setting:<workshop-folder>~<scope_kind>~<scope_id>`,
where scope_kind is person, film, piece or account. Its value holds `name`, `tool` (the Workshop folder), `scope_kind`,
`scope_id`, `settings` (the tool's settings, a JSON object or JSON text), `from` (where they came from) and `status`.
This ports old trillion's `setting` record kind (src/decision-store.mjs `setting(name)`: the value, or nothing when
there is none) to a row in the person's own list, read through their door.

A tool run on the person's computer is handed the record exactly as the door's `records:read` answers it, as
`settings_record` in its request (or a path to a JSON file holding that answer). A request may instead give `settings`
inline, for a sample run or a test. Standard library only.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

TYPE = 'record:setting'
PREFIX = 'record:setting:'
SCOPE_KINDS = ('person', 'film', 'piece', 'account')
_PART = re.compile(r'^[a-z0-9][a-z0-9._-]*$')


class SettingRefused(ValueError):
    """The settings could not be read; the message says what to change in the request."""


def setting_id(folder: str, scope_kind: str, scope_id: str) -> str:
    """The id of one tool's settings for one scope: record:setting:<folder>~<scope_kind>~<scope_id>."""
    if not isinstance(folder, str) or not _PART.match(folder):
        raise SettingRefused(f'the tool folder must be a Workshop folder name in lower case, not {folder!r}')
    if scope_kind not in SCOPE_KINDS:
        raise SettingRefused(f'scope_kind must be one of {", ".join(SCOPE_KINDS)}, not {scope_kind!r}')
    if not isinstance(scope_id, str) or not _PART.match(scope_id):
        raise SettingRefused(f'scope_id must be lower-case letters, digits, dots, dashes or underscores, not {scope_id!r}')
    return f'{PREFIX}{folder}~{scope_kind}~{scope_id}'


def parse_setting_id(record_id: str) -> dict:
    """{tool, scope_kind, scope_id} of a setting id, or SettingRefused naming the shape it must have."""
    if not isinstance(record_id, str) or not record_id.startswith(PREFIX):
        raise SettingRefused(f'a settings record id starts with {PREFIX!r}; {record_id!r} does not')
    parts = record_id[len(PREFIX):].split('~')
    if len(parts) != 3:
        raise SettingRefused(f'a settings record id is {PREFIX}<workshop-folder>~<scope_kind>~<scope_id>; {record_id!r} is not')
    tool, scope_kind, scope_id = parts
    setting_id(tool, scope_kind, scope_id)
    return {'tool': tool, 'scope_kind': scope_kind, 'scope_id': scope_id}


def _record_from(given) -> dict:
    if isinstance(given, str):
        path = Path(given)
        if not path.is_file():
            raise SettingRefused(f'settings_record names {given!r}, which is not a file: give the record the door read, or the path of a JSON file holding it')
        try:
            given = json.loads(path.read_text(encoding='utf-8'))
        except json.JSONDecodeError as exc:
            raise SettingRefused(f'settings_record file {given!r} is not JSON: {exc}') from None
    if not isinstance(given, dict):
        raise SettingRefused('settings_record must be the record the door read, { id, type, value }')
    return given


def setting_of(record, folder: str | None = None) -> dict:
    """Check one settings record and answer {id, tool, scope_kind, scope_id, name, from, status, settings}."""
    record = _record_from(record)
    record_id = record.get('id')
    where = parse_setting_id(record_id)
    if record.get('type', TYPE) != TYPE:
        raise SettingRefused(f'settings_record {record_id} has type {record.get("type")!r}; a setting is of type {TYPE!r}')
    if folder is not None and where['tool'] != folder:
        raise SettingRefused(f'settings_record {record_id} holds the settings of {where["tool"]}, not of {folder}: give this tool\'s own row ({PREFIX}{folder}~...)')
    value = record.get('value')
    if value is None:
        raise SettingRefused(f'there is no setting {record_id} in the person\'s list:settings: write it, or give the settings inline')
    if not isinstance(value, dict):
        raise SettingRefused(f'settings_record {record_id} has no value object')
    for field in ('tool', 'scope_kind', 'scope_id'):
        if field in value and value[field] != where[field]:
            raise SettingRefused(f'settings_record {record_id} says {field} is {value[field]!r}, but its id says {where[field]!r}: correct the row')
    if value.get('status') == 'retired':
        raise SettingRefused(f'setting {record_id} is retired: give the row that replaced it')
    settings = value.get('settings')
    if isinstance(settings, str):
        try:
            settings = json.loads(settings)
        except json.JSONDecodeError as exc:
            raise SettingRefused(f'the settings field of {record_id} is not JSON: {exc}') from None
    if not isinstance(settings, dict):
        raise SettingRefused(f'the settings field of {record_id} must be a JSON object')
    return {'id': record_id, **where, 'name': value.get('name'), 'from': value.get('from'), 'status': value.get('status'), 'settings': settings}


def settings_of(request: dict, folder: str | None = None, required: bool = True) -> dict | None:
    """The settings a request carries: from `settings_record` (checked), else inline `settings`. None when neither is given
    and `required` is false."""
    if not isinstance(request, dict):
        raise SettingRefused('the request must be a JSON object')
    if request.get('settings_record') is not None:
        return setting_of(request['settings_record'], folder)['settings']
    inline = request.get('settings')
    if inline is not None:
        if not isinstance(inline, dict):
            raise SettingRefused('settings must be a JSON object')
        return inline
    if required:
        where = f'{PREFIX}{folder}~<scope_kind>~<scope_id>' if folder else f'{PREFIX}<workshop-folder>~<scope_kind>~<scope_id>'
        raise SettingRefused(f'give settings_record: the row {where} from the person\'s list:settings, as the door read it (or settings inline)')
    return None
