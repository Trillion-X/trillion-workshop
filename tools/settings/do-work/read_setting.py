#!/usr/bin/env python3
"""Read one tool's settings for a person, film, piece or account from the rows given, or make the row to write.

One JSON request on standard input, one JSON answer as the last line of standard output: {"result": ...}.

  read: {"settings_record": <record | records | file path>, "folder": "<workshop folder>",
         "scopes": [{"kind": "film", "id": "..."}, ...], "default": <any>, "tool": "tool:..."}
        -> {"found": bool, "id": <record id or null>, "settings": <the settings or the default>}
  make: {"make": {"folder", "scope_kind", "scope_id", "settings", "name", "tool", "from", "status"?}, "with_list": bool}
        -> {"records": [<list:settings when with_list>, <the record:setting>]}

Exit 2 with {"error": ...} when the request cannot be read.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))

import settings as S  # noqa: E402


def answer(request: dict) -> dict:
    if 'make' in request:
        m = request['make']
        missing = [k for k in ('folder', 'scope_kind', 'scope_id', 'settings', 'name', 'tool', 'from') if k not in m]
        if missing:
            raise S.SettingError(f'make needs {", ".join(missing)}.')
        record = S.make_record(m['folder'], m['scope_kind'], m['scope_id'], m['settings'], name=m['name'],
                               tool=m['tool'], source=m['from'], status=m.get('status', 'active'))
        return {'records': ([S.list_record()] if request.get('with_list') else []) + [record]}
    scopes = request.get('scopes')
    if scopes is not None:
        if not isinstance(scopes, list) or not all(isinstance(s, dict) and 'kind' in s and 'id' in s for s in scopes):
            raise S.SettingError('scopes is a list of {"kind", "id"}, most specific first.')
        scopes = [(s['kind'], s['id']) for s in scopes]
    found = S.chosen(request.get('settings_record'), request.get('folder'), scopes)
    if found is None:
        return {'found': False, 'id': None, 'settings': request.get('default')}
    return {'found': True, 'id': found.get('id'), 'settings': S.settings_of(found, request.get('tool'))}


def main() -> int:
    try:
        request = json.loads(sys.stdin.read() or '{}')
        if not isinstance(request, dict):
            raise S.SettingError('The request is one JSON object.')
        print(json.dumps({'result': answer(request)}, ensure_ascii=False))
        return 0
    except (S.SettingError, json.JSONDecodeError) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
