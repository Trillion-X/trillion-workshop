#!/usr/bin/env python3
"""token_table_from_parts.py --request FILE   (or the request on standard input)

Writes word-template@1 token tables by hand, from the words a person keeps and the words they leave as slots, for a piece
make_template.py cannot read (no registry reader detects its file). Only spoken words are written; every other dimension is
left pending.

Request:
  {"out": FOLDER, "registry": the registry path to record in each template (default the shipped dimensions.json; a
   registry object, the person's own kept in their settings row, is recorded as "setting:<row id>"),
   "dim": "speech.word" (the dimension every word is written in),
   "reader": text naming how the table was made (default "hand-written token table"),
   "by": the maker named in each template's provenance (default "token_table_from_parts.py"),
   "templates": [{"name": file name stem, "piece_id": default the name, "medium": "video", "kind": "reference",
                  "t0": seconds, "t1": seconds, "unit_id": "u1", "source": where the words come from,
                  "parts": [["K", "kept words"] | ["S", SLOT, "words in the slot"], ...],
                  "slots": {SLOT: [type, note]}, "notes": {extra notes}}]}

Writes <out>/<name>.template.json for each and prints a last line {"result": {"written": [{"file", "tokens", "slots"}]}}
or {"error": "what to change"}. Exit 0, or 2 for an error.
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'read-data'))
from request_files import load_request  # noqa: E402


SHIPPED_REGISTRY = 'tools/fill-a-template-without-changing-its-words/read-data/dimensions.json'


class Refusal(Exception):
    """A request the tool cannot carry out; the message says what to change."""


def build(pid, t0, t1, parts, slots, source, registry, dim, unit_id='u1', notes=None, medium='video', kind='reference',
          reader='hand-written token table', by='token_table_from_parts.py'):
    """parts: list of ('K', text) or ('S', slot_id, text). Text is space-separated words."""
    DIM, REG = dim, registry  # the old script's module constants, now the request's
    tokens, n = [], 0
    for part in parts:
        mark, text = ('KEEP' if part[0] == 'K' else 'SLOT'), part[-1]
        if mark == 'SLOT' and (len(part) != 3 or part[1] not in slots):
            raise Refusal(f'piece {pid}: a slot part is ["S", SLOT, words] and SLOT must be a key of slots; got {part}')
        for w in text.split():
            tok = {'id': f'{unit_id}/speech/{n}', 'unit': unit_id, 'region': 'speech', 'dims': {DIM: w},
                   'mark': mark, 'record': f'{unit_id}.p1', 'word': True, 'line': {DIM: f'{DIM}:L1'}}
            if mark == 'SLOT':
                tok.update({'slot': part[1], 'slot_type': slots[part[1]][0], 'slot_note': slots[part[1]][1],
                            'slot_dims': [DIM]})
            tokens.append(tok)
            n += 1
    used = {t['slot'] for t in tokens if t['mark'] == 'SLOT'}
    return {
        'schema': 'word-template@1',
        'piece': {'id': pid, 'medium': medium, 'kind': kind,
                  'built_from': [{'reader': reader, 'path': source}],
                  'provenance': [{'op': 'hand_token_table', 'by': by}]},
        'registry': REG,
        'units': [{'id': unit_id, 'kind': 'shot', 't0': t0, 't1': t1, 'order': 1}],
        'lines': [{'id': f'{DIM}:L1', 'dim': DIM, 'job': None, 'tokens': [t['id'] for t in tokens]}],
        'slots': {k: {'type': slots[k][0], 'note': slots[k][1], 'rule': 'hand'} for k in slots if k in used},
        'tokens': tokens,
        'fills': {}, 'deleted': [], 'includes': [],
        'pending': [{'dim': d, 'reason': 'hand-written token table: only spoken words are written here'}
                    for d in ('drift.status',)],
        'conflicts': [], 'notes': {'language': 'en', **(notes or {})},
    }


def run(request):
    """Writes every template of the request; returns [{"file", "tokens", "slots"}]."""
    registry = request.get('registry', SHIPPED_REGISTRY)
    if isinstance(registry, dict):
        # the person's own registry kept in their settings row (make_template.py's shape): the template names the row, as
        # make_template.py does, so fill.py and drift.py ask for that row instead of measuring with another registry
        if not request.get('settings_row'):
            raise Refusal('the registry is an object but no settings row names it: give the row as settings_record, or a registry path')
        registry = 'setting:' + request['settings_row']
    for key in ('out', 'dim', 'templates'):
        if key not in request:
            raise Refusal(f'the request has no "{key}"; see the usage at the top of token_table_from_parts.py')
    os.makedirs(request['out'], exist_ok=True)
    written = []
    for spec in request['templates']:
        for key in ('name', 't0', 't1', 'source', 'parts', 'slots'):
            if key not in spec:
                raise Refusal(f'a template of the request has no "{key}": {spec.get("name", spec)}')
        t = build(spec.get('piece_id', spec['name']), spec['t0'], spec['t1'], spec['parts'], spec['slots'], spec['source'],
                  registry, request['dim'], unit_id=spec.get('unit_id', 'u1'), notes=spec.get('notes'),
                  medium=spec.get('medium', 'video'), kind=spec.get('kind', 'reference'),
                  reader=request.get('reader', 'hand-written token table'), by=request.get('by', 'token_table_from_parts.py'))
        path = os.path.join(request['out'], f'{spec["name"]}.template.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(t, f, ensure_ascii=False, indent=1)
        written.append({'file': path, 'tokens': len(t['tokens']), 'slots': len(t['slots'])})
    return written


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--request', action='append', help='a request JSON file (repeat it to lay later files over earlier ones, key by key); without it the request is read from standard input')
    a = ap.parse_args()
    try:
        request = load_request(a.request, tool='tool:write-a-word-template-from-the-words-i-keep-and-the-slots')
        written = run(request)
    except (Refusal, json.JSONDecodeError, OSError, ValueError) as e:
        print(json.dumps({'error': str(e)}))
        return 2
    print(json.dumps({'result': {'written': written}}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
