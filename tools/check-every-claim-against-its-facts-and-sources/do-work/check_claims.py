#!/usr/bin/env python3 -I
"""Check every claim of one or more narrated shots against the person's world rows and sources.

One JSON request on standard input, one JSON answer as the last printed line:

  {"shots": ["<shot id>", ...],
   "lane_dir": folder with shots/<id>.json, claims/<id>.json and the voice scripts the shots name,
   "sources": the sources file {"sources": {id: {"text": extract path relative to the file's folder, ...}}},
   "frames_root": the folder a claim's `frame` path is relative to,
   "world_dir": the person's world rows (lists.json, rows/<list>.json, relations.json),
   "hedge_phrases": ["phrases no claim may carry", ...]   (the person's no-hedge check row's words),
   "settings_record": the person's list:settings row (as records:read gives it, its value, or a file of it), whose
                      settings are {"rules": {...}, "subject_name", "narrator_name", "hedge_row"},
   "settings": optional object laid over the row's settings,
   "path_map": {"<prefix written on another computer>": "<prefix here>"}      (optional),
   "check_world": true (default: the world rows' own check must pass before any shot is checked),
   "quiet": false (true leaves the passing notes out of `lines`)}

The row is read with the one shared reader, tools/settings read-data/settings.py request_settings. A request that names
the row's id is run under tools/settings/do-work/run-with-settings.mjs, which reads it through the records door and
puts the record itself in settings_record; a row written for another tool, or retired, is refused.

Answer: {"result": {"ok", "shots": [{"id", "ok", "fails", "notes", "lines"}], "world": {"ok", "lines"}}}, exit 0 when
every shot passes and 1 when one fails; or {"error": "what to change"}, exit 2.
"""
import json
import os
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'read-data'))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), 'settings', 'read-data'))
import claim_gate  # noqa: E402
import world_rows  # noqa: E402
import settings as shared_settings  # noqa: E402  (tools/settings/read-data/settings.py)

FOLDER = 'check-every-claim-against-its-facts-and-sources'
TOOL = 'tool:check-every-claim-against-its-facts-and-sources'
NEEDED = ('shots', 'lane_dir', 'sources', 'frames_root', 'world_dir', 'hedge_phrases')
DEFAULTS = {'subject_name': 'the subject', 'narrator_name': 'the narrator', 'hedge_row': 'check row no-hedge-or-attribution'}
RULE_KEYS = ('strength', 'qualifiers', 'subject_words', 'no_claim', 'support_said_by_not', 'labels', 'accounting_skips',
             'auto_topic_kinds', 'bind_from_level', 'fillers', 'tense_markers', 'claim_fact_kinds', 'claim_said_by',
             'compounds', 'quantity_units', 'same_quantity_unit', 'unit_clause_breaks')


class Refusal(Exception):
    """A request this program cannot run; the message says what to change."""


def config_of(request):
    missing = [k for k in NEEDED if k not in request]
    if missing:
        raise Refusal(f'the request lacks {missing}; it needs {", ".join(NEEDED)} (see the top of check_claims.py)')
    if not isinstance(request['shots'], list) or not request['shots']:
        raise Refusal('shots must be a list of one or more shot ids')
    if 'settings_record' not in request and 'settings' not in request:
        raise Refusal('the request has no settings_record: give the person\'s list:settings row for this tool '
                      f'(record:setting:{FOLDER}~<scope_kind>~<scope_id>), or a settings object')
    try:
        settings = shared_settings.request_settings(request, DEFAULTS, folder=FOLDER, tool=TOOL)
    except shared_settings.SettingError as e:
        raise Refusal(str(e)) from None
    if not isinstance(settings, dict) or not isinstance(settings.get('rules'), dict):
        raise Refusal('the settings must hold "rules" (the person\'s claim rules, README.md: Rules)')
    absent = [k for k in RULE_KEYS if k not in settings['rules']]
    if absent:
        raise Refusal(f'settings.rules lacks {absent}; README.md: Rules says what each holds')
    if not isinstance(request['hedge_phrases'], list):
        raise Refusal('hedge_phrases must be a list of phrases (the words of the person\'s no-hedge check row)')
    for key in ('lane_dir', 'frames_root', 'world_dir'):
        if not os.path.isdir(request[key]):
            raise Refusal(f'{key} {request[key]} is not a folder')
    if not os.path.isfile(request['sources']):
        raise Refusal(f'sources {request["sources"]} is not a file')
    for name in ('lists.json', 'relations.json'):
        if not os.path.isfile(os.path.join(request['world_dir'], name)):
            raise Refusal(f'world_dir has no {name}; it holds the world rows (README.md: World rows)')
    return claim_gate.Config(request['lane_dir'], request['sources'], request['frames_root'], request['world_dir'],
                             request['hedge_phrases'], settings, request.get('path_map'))


def run(request):
    config = config_of(request)
    world = world_rows.World(config.world_dir)
    world_check = world_rows.verify(world, config.path_map) if request.get('check_world', True) else (True, ['verify: skipped'])
    shots, all_ok = [], True
    for sid in request['shots']:
        try:
            ok, lines, fails, notes = claim_gate.check(config, sid, request.get('quiet', False), world, world_check)
        except FileNotFoundError as e:
            ok, fails, notes = False, [f'{sid}: missing file {e.filename}'], []
            lines = [f'FAIL {fails[0]}', f'fact gate {sid}: 1 failures']
        shots.append({'id': sid, 'ok': ok, 'fails': fails, 'notes': notes, 'lines': lines})
        all_ok &= ok
    return {'ok': all_ok, 'shots': shots, 'world': {'ok': world_check[0], 'lines': world_check[1]}}


def main():
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise Refusal('the request must be one JSON object')
        result = run(request)
    except json.JSONDecodeError as e:
        print(json.dumps({'error': f'the request is not JSON ({e}); send one JSON object (see the top of check_claims.py)'}))
        return 2
    except Refusal as e:
        print(json.dumps({'error': str(e)}))
        return 2
    except OSError as e:
        print(json.dumps({'error': f'cannot read {e.filename}: {e.strerror}; check the folders the request names'}))
        return 2
    for shot in result['shots']:
        print('\n'.join(shot['lines']), file=sys.stderr)
    print(json.dumps({'result': result}, ensure_ascii=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
