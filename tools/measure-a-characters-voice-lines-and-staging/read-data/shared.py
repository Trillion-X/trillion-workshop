"""Print a YouTube json3 caption file as timed lines: one line per caption event, '>>' marks a speaker change.

What every script of this tool shares: the caption lines (events), the first caption file of a video among the person's
caption patterns, the catalog table, the request with the settings it names, the person's word rules judged by the one
word judge (tools/judge-words), and the answer printed as the last line.

A caption pattern is a path with {id} for the video id and, optionally, shell wildcards (`captions/{id}.en*.json3`); the
patterns are tried in the order given and the first that matches a file wins (the first in name order).
"""
import csv
import glob
import json
import os
import subprocess
import sys

FOLDER = 'measure-a-characters-voice-lines-and-staging'
TOOLS = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KEYS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'settings-keys.json')))['keys']
TYPES = {'rules': (dict, list), 'number': (int, float), 'integer': (int,), 'string': (str,), 'object': (dict,), 'array': (list,), 'boolean': (bool,)}


def events(path):
    d = json.load(open(path, encoding='utf-8'))
    out = []
    for e in d.get('events', []):
        segs = e.get('segs')
        if not segs:
            continue
        t = ''.join(s.get('utf8', '') for s in segs).replace('\n', ' ').strip()
        if t:
            out.append((e.get('tStartMs', 0) / 1000.0, e.get('dDurationMs', 0) / 1000.0, t))
    return out


def caption_file(video_id, patterns):
    """The first file a pattern names for this video, or None."""
    for pattern in patterns:
        found = sorted(glob.glob(pattern.replace('{id}', video_id)))
        if found:
            return found[0]
    return None


def catalog(path):
    """{id: row} of a tab-separated catalog with at least the columns id and format (made by do-work/catalog_videos.py)."""
    return {r['id']: r for r in csv.DictReader(open(path), delimiter='\t')}


def fail(message):
    """Refuse the request: {"error": ...} as the last line, exit 2."""
    print(json.dumps({'error': message}))
    sys.exit(2)


def answer(value):
    """The last line every do-work script prints."""
    print(json.dumps({'result': value}))


def found(name, *places):
    """The first of `places` (paths under this tool's sibling folders, then under /opt) that exists."""
    for base in (TOOLS, '/opt'):
        for place in places:
            path = os.path.join(base, place)
            if os.path.exists(path):
                return path
    fail(f'{name} is not here: run this tool from a Workshop checkout, or pack {places[0]}')


def settings_of(given, scopes=None):
    """The settings object of the person's settings row, read by the one reader, tools/settings (read-data/settings.py).

    `given` is the row as records:read answers it ({id, type: "record:setting", value}), its value, a list of rows, or
    the path of a JSON file holding them; `scopes` ([(kind, id)], most specific first) chooses among several rows."""
    reader = os.path.dirname(found('tools/settings', 'settings/read-data/settings.py'))
    if reader not in sys.path:
        sys.path.insert(0, reader)
    import settings
    if isinstance(given, str) and given.startswith('record:setting:'):
        fail(f'settings_record names the row {given}: read it with records:read and give the row itself (or a file holding it)')
    try:
        held = settings.setting(given, FOLDER, scopes, default=None)
    except settings.SettingError as exc:
        fail(f'settings_record: {exc}')
    if held is None:
        fail(f'settings_record holds no row of tools/{FOLDER} for the scopes asked: give this tool\'s own settings row')
    if not isinstance(held, dict):
        fail('settings_record: its settings are not one JSON object')
    return held


def request(needs, defaults=None):
    """The request on standard input and the settings it runs with: this tool's `defaults`, under the person's settings
    row (`settings_record`), under the request's own `settings`. Refuses a request whose settings lack a key `needs`
    names, or hold it with the wrong type (read-data/settings-keys.json says what each key means)."""
    unknown = [key for key in list(needs) + list(defaults or {}) if key not in KEYS]
    if unknown:
        raise ValueError(f'settings-keys.json does not list {unknown}')
    try:
        req = json.loads(sys.stdin.read() or '{}')
    except ValueError as exc:
        fail(f'the request is not JSON ({exc}): send one JSON object on standard input')
    if not isinstance(req, dict):
        fail('the request is one JSON object')
    s = dict(defaults or {})
    if req.get('settings_record') is not None:
        scopes = req.get('scopes')
        if scopes is not None and not (isinstance(scopes, list) and all(isinstance(x, dict) and 'kind' in x and 'id' in x for x in scopes)):
            fail('scopes, when given, is a list of {kind, id}, most specific first (piece, film, person, account)')
        s.update(settings_of(req['settings_record'], None if scopes is None else [(x['kind'], x['id']) for x in scopes]))
    if req.get('settings') is not None:
        if not isinstance(req['settings'], dict):
            fail('settings, when given, is a JSON object of settings keys')
        s.update(req['settings'])
    problems = [f"{key} is missing ({KEYS[key]['meaning']})" for key in needs if key not in s]
    problems += [f"{key} must be a {KEYS[key]['type']}" for key in list(needs) + list(defaults or {})
                 if key in s and (isinstance(s[key], bool) != (KEYS[key]['type'] == 'boolean')
                                  or not isinstance(s[key], TYPES[KEYS[key]['type']]))]
    if problems:
        fail('the settings are not complete (give settings_record, the person\'s settings row, or settings): '
             + '; '.join(problems))
    return req, s


def needed(req, *fields):
    """The request's values of `fields`, refusing a request without one."""
    missing = [f for f in fields if req.get(f) in (None, '', [])]
    if missing:
        fail(f'the request needs {", ".join(missing)}')
    return [req[f] for f in fields]


def rules_of(value):
    """{name: regular expression} in the person's order, from an object or from a list of [name, pattern] pairs (a
    settings row keeps its JSON with sorted keys, so a list is how an order that matters is kept)."""
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, list) and all(isinstance(x, list) and len(x) == 2 and all(isinstance(y, str) for y in x) for x in value):
        return {name: pattern for name, pattern in value}
    fail('a rules setting is {name: pattern} or [[name, pattern], ...]')


def matches(rules, texts):
    """[set of rule names] per text, in order, judged by the one word judge, tools/judge-words (judge-against-rules.mjs).

    rules is {name: regular expression}, matched case-insensitively. The texts go in one request as items, and each
    finding names its item, so no second matcher exists here. Needs node."""
    judge = found('tools/judge-words', 'judge-words/do-work/judge-against-rules.mjs')
    hit = [set() for _ in texts]
    items = [{'text': t, 'path': [i]} for i, t in enumerate(texts) if t and t.strip()]
    if not items or not rules:
        return hit
    ask = {'rules': [{'id': name, 'pattern': pattern, 'flags': 'i'} for name, pattern in rules.items()], 'items': items}
    run = subprocess.run(['node', judge], input=json.dumps(ask), capture_output=True, text=True)
    said = json.loads(run.stdout.strip().splitlines()[-1]) if run.stdout.strip() else {'error': run.stderr.strip()}
    if 'error' in said:
        fail(f'the word judge refused the rules: {said["error"]}')
    for finding in said['result']['findings']:
        hit[int(finding['path'])].add(finding['rule'])
    return hit
