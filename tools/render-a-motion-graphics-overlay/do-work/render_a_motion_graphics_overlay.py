#!/usr/bin/env python3
"""Render a motion-graphics overlay: one JSON request on standard input, one JSON answer as the last printed line.

The row runs this under tools/settings do-work/run-with-settings.mjs (through do-work/render-overlay.mjs, which also reads a
spec_record), so a `settings_record` id arrives as the record itself. The look is, weakest first: settings_files, the
person's settings row (settings_record), the request's own `settings` (tools/settings request_settings).

Request:
  settings_record  the person's look row (handed as the record), or the record, its value or a file of them
  settings  the look (overlay/look.py says what it holds): recipe, look, look3, frame, faces, sound_layers, named sections
  settings_files  optional: JSON files of a look kept on this computer, laid under `settings` in order (weakest first)
  spec      the spec: {id, duration_s, events: [{type, at, ...}], voice?, canvas?, still_bg?, still_format?, qscale?,
            sound_trim_db?, subtitles?}
  assets    the folder the settings' relative file names (faces, textures, recordings) are read from
  root      optional: the folder a spec's relative file names (voice, clips, pictures, mattes) are read from; default assets
  out       the folder the overlay, sound, timeline and the render's own scratch are written to
  stills    optional: seconds; writes those frames over the spec's still_bg instead of the overlay video
  lock      optional: {file, wait_while?: {file, says, poll_s, max_s}}; one render at a time on this computer
Answer: {"result": {"id", "frames", "duration_s", "overlay", "sound"?, "sfx_only"?, "timeline"}} or {"result": {"id", "stills"}};
{"error": "..."} on the last line, exit 1, when the request is refused.

Run from anywhere: python3 tools/render-a-motion-graphics-overlay/do-work/render_a_motion_graphics_overlay.py < request.json
Python puts this file's folder first on its search path, so the overlay package beside it is found."""
import json
import os
import sys

NEEDED = ('spec', 'assets', 'out')
FOLDER = 'render-a-motion-graphics-overlay'
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(1, os.path.join(HERE, '..', '..', 'settings', 'read-data'))  # tools/settings, packed at /opt/settings
# keys of a spec whose string value names a file: read against the request's root unless absolute
FILE_KEYS = {'src', 'image', 'photo', 'matte', 'wav', 'file', 'still_bg', 'picture', 'mask'}


def refuse(text):
    print(json.dumps({'error': text}))
    raise SystemExit(1)


def resolve_files(node, root):
    """A copy of the spec with every file name (FILE_KEYS, and `words` when it names a .json file) read against root."""
    if isinstance(node, list):
        return [resolve_files(x, root) for x in node]
    if not isinstance(node, dict):
        return node
    out = {}
    for k, v in node.items():
        if isinstance(v, str) and v and v != 'none' and (k in FILE_KEYS or (k == 'words' and v.endswith('.json'))):
            out[k] = v if os.path.isabs(v) else os.path.join(root, v)
        else:
            out[k] = resolve_files(v, root)
    return out


def read_request(text):
    try:
        req = json.loads(text)
    except json.JSONDecodeError as err:
        refuse(f'the request is not JSON ({err}); send one JSON object with {", ".join(NEEDED)}')
    if not isinstance(req, dict):
        refuse(f'the request must be a JSON object with {", ".join(NEEDED)}')
    missing = [k for k in NEEDED if k not in req]
    if not any(k in req for k in ('settings', 'settings_record', 'settings_files')):
        missing.append('settings')
    if missing:
        refuse(f'the request lacks {missing}: give settings (or settings_record, or settings_files), spec (or spec_record), assets and out')
    import settings as reader  # tools/settings/read-data/settings.py
    try:
        look = reader.request_settings(req, {}, folder=FOLDER, tool=f'tool:{FOLDER}')
    except reader.SettingError as err:
        refuse(str(err))
    if 'settings_files' in req:
        files = req['settings_files']
        if not isinstance(files, list) or not all(isinstance(f, str) for f in files):
            refuse('settings_files must be a list of JSON file paths')
        under = {}
        for f in files:
            if not os.path.isfile(f):
                refuse(f'no settings file at {f}; give the path of an existing JSON file')
            under = reader.lay_over(under, json.load(open(f)))
        look = reader.lay_over(under, look)
    req['settings'] = look
    spec = req['spec']
    if isinstance(spec, str):  # a spec file on this computer
        if not os.path.isfile(spec):
            refuse(f'no spec file at {spec}; give the spec object, or the path of an existing spec file')
        spec = json.load(open(spec))
    if not isinstance(spec, dict) or not isinstance(spec.get('events'), list) or 'id' not in spec or 'duration_s' not in spec:
        refuse('spec must be an object with id, duration_s and events (a list of {type, at, ...})')
    if not isinstance(req['settings'], dict):
        refuse('settings must be a JSON object (the look): recipe, look, look3, frame, faces')
    for k in ('assets', 'out'):
        if not isinstance(req[k], str) or not req[k]:
            refuse(f'{k} must be a folder path')
    if not os.path.isdir(req['assets']):
        refuse(f'no assets folder at {req["assets"]}; give the folder the look\'s file names are read from')
    root = req.get('root') or req['assets']
    return req, resolve_files(spec, root), root


def main():
    try:
        run(sys.stdin.read())
    except SystemExit as stop:  # a render that stops says why in words: the answer's error, exit 1
        if isinstance(stop.code, str):
            refuse(stop.code)
        raise


def run(text):
    req, spec, root = read_request(text)
    from overlay import look
    try:
        look.install([req['settings']], req['assets'], root, req['out'])
    except look.SettingsRefused as err:
        refuse(str(err))
    from overlay import events
    from overlay.build import Build
    from overlay.render import render, render_lock
    unknown = sorted({e.get('type') for e in spec['events']} - set(events.bind(Build)))
    if unknown:
        refuse(f'spec {spec["id"]}: no event type {unknown}; the types are the ev_<type> functions in do-work/overlay/events/')
    with render_lock(req.get('lock')):
        answer = render(spec, req.get('stills'))
    print(json.dumps({'result': answer}))


if __name__ == '__main__':
    main()
