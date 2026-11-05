"""Reads a command's request: one or more JSON files laid over each other, or standard input.

A request is the person's settings (what the words are, which slots, what the ids look like) plus where this run writes.
Keeping them in separate files lets the settings be a row of the person's own records and the paths stay with the run.
Files are laid in the order given, key by key; a key that holds an object in both is merged one level down (so `out`
can name some paths in one file and the rest in another).

The person's settings are a row of their list:settings,
`record:setting:fill-a-template-without-changing-its-words~<scope_kind>~<scope_id>`, read by the one shared reader
(tools/settings read-data/settings.py `request_settings`): the request's `settings_record` is that record (as
records:read gives it, its value, or a file of it; run-with-settings.mjs puts it there when the request names its
id), and the request's own `settings` object lays over it. The result is laid UNDER the request's other keys with the
merge above, so a run's paths and any key the run names win.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'settings' / 'read-data'))
import settings as shared_settings  # noqa: E402  (tools/settings/read-data/settings.py)

FOLDER = 'fill-a-template-without-changing-its-words'
SETTINGS_KEYS = ('settings', 'settings_record', 'settings_from', 'scope')


def lay(under, over):
    """`over` laid on `under`, key by key; an object in both is merged one level down."""
    out = dict(under)
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = {**out[key], **value}
        else:
            out[key] = value
    return out


def scopes_of(request):
    """`scope`: "KIND:ID" or a list of them, most specific first (the same as the other commands' --scope), when
    settings_record holds several rows of this folder (the registry row of make_template.py among them)."""
    given = request.get('scope')
    if given is None:
        return None
    from wt_core import parse_scopes  # noqa: E402  (the folder's one --scope parser)
    return parse_scopes([given] if isinstance(given, str) else given)


def with_settings(request, tool=None):
    """The request with the person's settings (row, then its own `settings`) laid under its other keys. The chosen
    row's id is kept as `settings_row`, so a template can name the row its registry came from."""
    if not any(k in request for k in ('settings', 'settings_record')):
        return request
    scopes = scopes_of(request)
    settings = shared_settings.request_settings(request, {}, folder=FOLDER, scopes=scopes, tool=tool)
    if not isinstance(settings, dict):
        raise ValueError('the settings row holds no JSON object: write the row\'s settings as an object')
    rest = {k: v for k, v in request.items() if k not in SETTINGS_KEYS}
    out = lay(settings, rest)
    given = request.get('settings_record')
    if given is not None and not isinstance(given, str):
        row = shared_settings.chosen(given, FOLDER, scopes)
        if isinstance(row, dict) and row.get('id'):
            out.setdefault('settings_row', row['id'])
    return out


def load_request(paths, stdin=None, tool=None):
    """paths: list of file names (or None to read the one request from stdin)."""
    if not paths:
        return with_settings(json.load(stdin if stdin is not None else sys.stdin), tool)
    request = {}
    for path in paths:
        with open(path, encoding='utf-8') as f:
            request = lay(request, json.load(f))
    return with_settings(request, tool)
