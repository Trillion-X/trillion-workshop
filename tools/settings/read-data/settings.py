"""tools/settings/read-data/settings.py

The Python twin of read-data/settings.mjs, for Python tools: the same ids, the same checks, the same words, all read
from read-data/settings.json. A Python tool gets the setting row's value from its caller (or from `read`, any callable
answering the value of (record type, id) or None) and calls `settings_of(value, settings_record, tool=...)`.
Old owner: old trillion src/decision-store.mjs before commit 4ffa1dc4a2, lines 8 and 751-762 (the `setting` kind).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

DATA = json.loads((Path(__file__).resolve().parent / 'settings.json').read_text(encoding='utf-8'))
KINDS = ', '.join(DATA['scope_kinds'])


class SettingError(ValueError):
    def __init__(self, code: str, **fill: Any) -> None:
        words = DATA['words'][code]
        for name, value in fill.items():
            words = words.replace('{' + name + '}', str(value))
        super().__init__(words)
        self.code = code


def _plain(value: Any) -> bool:
    return isinstance(value, str) and bool(value) and DATA['separator'] not in value and '/' not in value


def setting_id(tool: str, scope_kind: str, scope_id: str) -> str:
    for field, value in (('tool', tool), ('scope_kind', scope_kind), ('scope_id', scope_id)):
        if not _plain(value):
            raise SettingError('bad_part', field=field, value=json.dumps(value))
    if scope_kind not in DATA['scope_kinds']:
        raise SettingError('bad_scope_kind', id=f"{tool}{DATA['separator']}{scope_kind}", scope_kind=scope_kind, kinds=KINDS)
    sep = DATA['separator']
    return f"{DATA['id_prefix']}{tool}{sep}{scope_kind}{sep}{scope_id}"


def parse_setting_id(id_: Any) -> dict:
    if not isinstance(id_, str) or not id_.startswith(DATA['id_prefix']):
        raise SettingError('bad_id', id=json.dumps(id_), kinds=KINDS)
    parts = id_[len(DATA['id_prefix']):].split(DATA['separator'])
    if len(parts) != 3 or not all(_plain(part) for part in parts):
        raise SettingError('bad_id', id=json.dumps(id_), kinds=KINDS)
    tool, scope_kind, scope_id = parts
    if scope_kind not in DATA['scope_kinds']:
        raise SettingError('bad_scope_kind', id=id_, scope_kind=scope_kind, kinds=KINDS)
    return {'tool': tool, 'scope_kind': scope_kind, 'scope_id': scope_id}


def settings_of(value: Any, id_: str, tool: str | None = None) -> dict:
    named = parse_setting_id(id_)
    if tool is not None and named['tool'] != tool:
        raise SettingError('other_tool', id=id_, owner=named['tool'], tool=tool)
    if value is None:
        raise SettingError('missing', id=id_)
    if value.get('status') != DATA['active_status']:
        raise SettingError('not_active', id=id_, status=json.dumps(value.get('status')))
    if value.get('tool') != named['tool']:
        raise SettingError('value_tool', id=id_, owner=json.dumps(value.get('tool')), tool=named['tool'])
    settings = value.get('settings')
    if isinstance(settings, str):
        try:
            settings = json.loads(settings)
        except json.JSONDecodeError:
            raise SettingError('bad_settings', id=id_) from None
    if not isinstance(settings, dict):
        raise SettingError('bad_settings', id=id_)
    return settings


def read_settings(read: Callable[[str, str], Any], settings_record: str, tool: str | None = None) -> dict:
    named = parse_setting_id(settings_record)
    if tool is not None and named['tool'] != tool:
        raise SettingError('other_tool', id=settings_record, owner=named['tool'], tool=tool)
    return settings_of(read(DATA['record_type'], settings_record), settings_record, tool)


def setting_row(tool: str, scope_kind: str, scope_id: str, settings: dict, name: str | None = None,
                from_: str | None = None, status: str | None = None) -> dict:
    id_ = setting_id(tool, scope_kind, scope_id)
    if not isinstance(settings, dict):
        raise SettingError('bad_settings', id=id_)
    value = {'name': name or f'{tool} for {scope_kind} {scope_id}', 'tool': tool, 'scope_kind': scope_kind,
             'scope_id': scope_id, 'settings': settings, 'status': status or DATA['active_status']}
    if from_ is not None:
        value['from'] = from_
    return {'id': id_, 'type': DATA['record_type'], 'value': value}
