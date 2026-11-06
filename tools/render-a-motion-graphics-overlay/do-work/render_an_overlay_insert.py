#!/usr/bin/env python3
"""Render correction inserts: for each shot, its overlay and what an editor needs to cut it into the film (the narrator
voice and the music-and-effects stem aligned to the overlay's first frame, the S-Log3 and graded freeze plates, an
in-context preview), after the shot's claims pass tool:check-every-claim-against-its-facts-and-sources. One JSON request
on standard input, one JSON answer as the last printed line. overlay/insert.py says what each file is.

The row runs this under tools/settings run-with-settings.mjs (through do-work/render-insert.mjs, which also reads
spec_record / spec_records), so a `settings_record` id arrives as the record itself. The look is read exactly as for
tool:render-a-motion-graphics-overlay (render_a_motion_graphics_overlay.py read_request): settings_files, then the
person's look row, then the request's own `settings`.

Request (besides the overlay renderer's settings_record / settings / settings_files, assets, root, out and lock):
  spec | specs   one shot or a list of shots (a batch renders one after another under one lock); each shot writes into
                 out/<shot id>/
  mode           full (default) | quick (sound and a 540p preview with the overlay piped in) | audio_only
  stills         seconds: those frames over each shot's cut-out picture instead of the videos
  preview_encoder  the H.264 encoder of this computer; default the look's insert.preview_encoder, else h264_videotoolbox
  claim_check    tool:check-every-claim-against-its-facts-and-sources's request without shots, or {"skip": "<why>"};
                 default the look's insert.claim_check. A shot whose claims fail is refused and nothing is rendered.
  copy_previews_to  {folder, names?: {shot id: file name without .mp4}}: each preview is also copied there (a picker);
                 names default to the look's insert.picker_names, then the shot id
  lock           as for the overlay; default the look's insert.lock. It is held for the whole batch.
Answer: {"result": {"inserts": [{id, frames, duration_s, timeline, claim_check, overlay?, narrator?, sfx_music?, plate?,
plate_graded?, preview?, stills?, copied_to?}]}}; {"error": "..."} on the last line, exit 1, when refused.

Run from anywhere: python3 tools/render-a-motion-graphics-overlay/do-work/render_an_overlay_insert.py < request.json"""
import json
import os
import sys

import render_a_motion_graphics_overlay as base

MODES = ('full', 'quick', 'audio_only')


def read_request(text):
    """The request with every shot checked and its file names read against root; a shot without duration_s lasts until its
    exit (overlay/insert.py)."""
    try:
        req = json.loads(text)
    except json.JSONDecodeError as err:
        base.refuse(f'the request is not JSON ({err}); send one JSON object with settings, spec or specs, assets and out')
    if not isinstance(req, dict):
        base.refuse('the request must be a JSON object with settings, spec or specs, assets and out')
    if 'specs' in req:
        if 'spec' in req or not isinstance(req['specs'], list) or not req['specs']:
            base.refuse('give spec (one shot) or specs (a non-empty list of shots), not both')
        shots = req.pop('specs')
    else:
        shots = [req.get('spec')] if 'spec' in req else []
    root = req.get('root') or req.get('assets')
    if isinstance(root, str) and root:
        req['root'] = os.path.abspath(root)  # file names read against it once, so a relative root is not joined twice
    for i, shot in enumerate(shots):
        if isinstance(shot, str):  # a shot file on this computer
            if not os.path.isfile(shot):
                base.refuse(f'no shot file at {shot}; give the shot object, or the path of an existing shot file')
            shots[i] = json.load(open(shot))
    for i, shot in enumerate(shots):
        if isinstance(shot, dict) and 'duration_s' not in shot:
            shots[i] = dict(shot, duration_s=None)
    resolved = []
    for shot in shots or [None]:
        one = dict(req, spec=shot) if shot is not None else req
        checked, spec, root = base.read_request(json.dumps(one))
        for key in ('plate', 'graded_frame'):
            if isinstance(spec.get(key), dict):
                for name in ('source', 'export'):
                    v = spec[key].get(name)
                    if isinstance(v, str) and v and not os.path.isabs(v):
                        spec[key] = dict(spec[key], **{name: os.path.join(root, v)})
        resolved.append(spec)
    mode = checked.get('mode', 'full')
    if mode not in MODES:
        base.refuse(f'mode must be one of {list(MODES)}')
    copies = checked.get('copy_previews_to')
    if copies is not None and (not isinstance(copies, dict) or not isinstance(copies.get('folder'), str) or not isinstance(copies.get('names', {}), dict)):
        base.refuse('copy_previews_to must be {"folder": "<folder>", "names": {"<shot id>": "<file name without .mp4>"}}')
    ids = [s['id'] for s in resolved]
    if len(set(ids)) != len(ids):
        base.refuse(f'a batch names a shot twice: {sorted({i for i in ids if ids.count(i) > 1})}')
    return checked, resolved


def main():
    try:
        run(sys.stdin.read())
    except SystemExit as stop:
        if isinstance(stop.code, str):
            base.refuse(stop.code)
        raise


def run(text):
    req, shots = read_request(text)
    from overlay import look
    try:
        look.install([req['settings']], req['assets'], req.get('root') or req['assets'], req['out'])
    except look.SettingsRefused as err:
        base.refuse(str(err))
    from overlay import events
    from overlay.build import Build
    from overlay.render import render_lock
    from overlay import insert
    known = set(events.bind(Build))
    for spec in shots:
        unknown = sorted({e.get('type') for e in spec['events']} - known)
        if unknown:
            base.refuse(f'shot {spec["id"]}: no event type {unknown}; the types are the ev_<type> functions in do-work/overlay/events/')
    defaults = look.SECTIONS.get('insert', {})
    encoder = req.get('preview_encoder', defaults.get('preview_encoder', 'h264_videotoolbox'))
    claim_check = req.get('claim_check', defaults.get('claim_check'))
    if not isinstance(claim_check, dict):
        base.refuse('give claim_check: tool:check-every-claim-against-its-facts-and-sources\'s request without shots, '
                    'or {"skip": "<why this shot makes no claim>"}; a correction is never rendered unchecked')
    copies = req.get('copy_previews_to') or {}
    names = copies.get('names') or defaults.get('picker_names', {})
    answers = []
    with render_lock(req.get('lock', defaults.get('lock'))):
        for spec in shots:
            name = names.get(spec['id'], spec['id']) if copies else None
            copy_to = os.path.join(copies['folder'], f'{name}.mp4') if copies else None
            answers.append(insert.render_insert(spec, os.path.join(req['out'], spec['id']), mode=req.get('mode', 'full'),
                                                stills=req.get('stills'), encoder=encoder, claim_check=claim_check, copy_to=copy_to))
    print(json.dumps({'result': {'inserts': answers}}))


if __name__ == '__main__':
    main()
