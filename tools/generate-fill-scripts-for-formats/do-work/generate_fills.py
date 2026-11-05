"""Fill every format's script template with every capability: one JSON request in, one JSON answer out.

  python3 -I do-work/generate_fills.py [--request FILE | --records FILE ... --batch ID] [--out DIR | --rows-out FILE --batch NAME] < request.json

The request (on standard input, or --request FILE) is described in read-data/fill_text.py and the README; a request
{ rows, batch } (or --records) is put together from the person's list rows instead (each FILE a records export: { records: [{ id, type, value }] }),
from the batch row whose id ends with ID. With --out, every page is also written under DIR (<format>/<capability>.md and the
index), and the answer gives each page's path instead of its text. With --rows-out FILE --batch NAME, the request is written as
the rows that hold it (see read-data/fill_records.py; a setting the settings row gives with the same value is left out) and nothing is filled. The last line printed is the answer.

The person's settings (the page layout, over_budget, standard_holes and any value the layout names) can come as their
`settings_record` (in the request, or --settings-record FILE): a list:settings row read through tools/settings
(record:setting:generate-fill-scripts-for-formats~<scope_kind>~<scope_id>, the first of `settings_scopes` that has a row,
default the account `main`). The request's own `settings` (or the batch row's) are laid over it, key by key.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))
sys.path.insert(1, str(Path(__file__).resolve().parents[2] / 'settings' / 'read-data'))
import fill_records  # noqa: E402
import fill_text  # noqa: E402
import settings as settings_rows  # noqa: E402

FOLDER = 'generate-fill-scripts-for-formats'
TOOL = 'tool:' + FOLDER
DEFAULT_SCOPES = [('account', 'main')]


def with_settings_record(request: dict, given, scopes) -> dict:
    """The request with the person's settings row under its own settings: the row gives each key the request leaves out."""
    try:
        scopes = [tuple(s) for s in (scopes or DEFAULT_SCOPES)]
        if not all(len(s) == 2 for s in scopes):
            raise ValueError
    except (TypeError, ValueError):
        raise fill_text.TemplateError('settings_scopes is a list of [scope_kind, scope_id] pairs, most specific first, '
                                      'e.g. [["account", "main"]].') from None
    held = settings_rows.setting(given, FOLDER, scopes, default=None, tool=TOOL)
    if held is None:
        named = ', '.join(f'{k}~{i}' for k, i in scopes)
        raise fill_text.TemplateError(f'settings_record has no {FOLDER} row for {named}: give the row '
                                      f'record:setting:{FOLDER}~<scope_kind>~<scope_id> from list:settings, or the settings themselves.')
    if not isinstance(held, dict):
        raise fill_text.TemplateError(f'The {FOLDER} settings row holds {type(held).__name__}, not an object of settings.')
    return {**request, 'settings': {**held, **(request.get('settings') or {})}, 'row_settings': held}


def main() -> int:
    ap = argparse.ArgumentParser(description='Fill format script templates with capabilities.')
    ap.add_argument('--request', type=Path)
    ap.add_argument('--records', type=Path, nargs='+')
    ap.add_argument('--batch')
    ap.add_argument('--out', type=Path)
    ap.add_argument('--rows-out', type=Path, help='write the rows that hold the request (batch --batch) and fill nothing')
    ap.add_argument('--settings-record', type=Path, help='a JSON file of the list:settings row(s) to read the settings from')
    a = ap.parse_args()
    try:
        if a.records:
            if not a.batch:
                raise fill_text.TemplateError('--records needs --batch: the id (or the end of the id) of the batch row to fill.')
            docs = [json.loads(p.read_text(encoding='utf-8')) for p in a.records]
            request = fill_records.request_from_rows([r for d in docs for r in d['records']], a.batch)
        else:
            request = json.loads(a.request.read_text(encoding='utf-8') if a.request else sys.stdin.read())
            if 'rows' in request:
                request = {**{k: request[k] for k in ('settings_record', 'settings_scopes') if k in request},
                           **fill_records.request_from_rows(request['rows'], request.get('batch', ''))}
        given = str(a.settings_record) if a.settings_record else request.get('settings_record')
        held_keys: tuple = ()
        if given is not None:
            own = request.get('settings') or {}
            request = with_settings_record(request, given, request.get('settings_scopes'))
            # what the rows need not hold: each setting the row gives, unless the request gives it a value of its own
            row = request['row_settings']
            held_keys = tuple(k for k in row if k not in own or own[k] == row[k])
        request.pop('row_settings', None)
        request.pop('settings_record', None)
        request.pop('settings_scopes', None)
        if a.rows_out:
            if not a.batch:
                raise fill_text.TemplateError('--rows-out needs --batch: the name of the batch the rows hold.')
            problems = fill_text.check(request)
            if problems:
                raise fill_text.TemplateError(' '.join(problems))
            rows = fill_records.rows_from_request(request, a.batch, leave_out=held_keys)
            a.rows_out.write_text(json.dumps({'rows': rows}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
            print(json.dumps({'rows': len(rows), 'file': str(a.rows_out)}))
            return 0
        answer = fill_text.fill_all(request)
    except KeyError as e:
        print(json.dumps({'error': f'The request lacks the key {e}; the README gives the shape of a request.'}, ensure_ascii=False))
        return 2
    except (fill_text.TemplateError, fill_records.RowError, settings_rows.SettingError, json.JSONDecodeError) as e:
        print(json.dumps({'error': str(e)}, ensure_ascii=False))
        return 2
    if a.out:
        pages = answer['fills'] + ([answer['index']] if 'index' in answer else [])
        for p in pages:
            path = a.out / p['file']
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(p.pop('text'), encoding='utf-8')
            p['path'] = str(path)
    print(json.dumps(answer, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
