#!/usr/bin/env python3
"""vary_slots_one_at_a_time.py --request FILE   (or the request on standard input)

Makes the candidates of a spoken line: the base picks, then every other candidate of each slot with all the other slots at
their base pick, so one slot varies at a time. Each variant gets a script line, a shot file and a claims file; the claims
file has one entry per sentence, taken from the candidate that formed the sentence (the checker of facts reads it).

Request:
  {"slots": [{"name": SLOT, "base": candidate id, "candidates": {id: {"text": words the slot adds, "claim": {...} | null}}}],
   "sentences": [{"template": "words with {SLOT} where a slot's words go", "claim_from": SLOT}
                 | {"template": "fixed words", "claim": {...}}],
   "id_prefix": "<prefix>-", "script_path": "<folder>/{id}.txt" (the script path written in each shot file),
   "shot_about": text with {variant}, {picks}, {id}, "claims_about": text with the same fields,
   "out": {"here": FOLDER (lines/<id>.txt, lines.txt, manifest.json), "narrator": FOLDER (shots/<id>.json, claims/<id>.json)}}

A sentence whose filled words are empty is left out and has no claim. A claim entry is written as
{"words": the sentence, "kind": "claim", ...the claim's own keys}. Variant ids are the candidate ids; the base is "base".
Prints a last line {"result": {"variants": N, "ids": [...]}} or {"error": "what to change"}. Exit 0, or 2 for an error.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'read-data'))
from request_files import load_request  # noqa: E402


class Refusal(Exception):
    """A request the tool cannot carry out; the message says what to change."""


def check(request):
    for key in ('slots', 'sentences', 'id_prefix', 'script_path', 'shot_about', 'claims_about', 'out'):
        if key not in request:
            raise Refusal(f'the request has no "{key}"; see the usage at the top of vary_slots_one_at_a_time.py')
    for key in ('here', 'narrator'):
        if key not in request['out']:
            raise Refusal(f'the request has no out.{key}')
    names = [s['name'] for s in request['slots']]
    for s in request['slots']:
        if s['base'] not in s['candidates']:
            raise Refusal(f'slot {s["name"]}: the base pick {s["base"]} is not one of its candidates {sorted(s["candidates"])}')
    for sentence in request['sentences']:
        for name in re.findall(r'\{(\w+)\}', sentence['template']):
            if name not in names:
                raise Refusal(f'a sentence names the slot {{{name}}}, which is not one of the slots {names}')
        if 'claim_from' in sentence and sentence['claim_from'] not in names:
            raise Refusal(f'a sentence takes its claim from {sentence["claim_from"]}, which is not one of the slots {names}')


def picks_of(request):
    """{variant id: {slot: candidate id}}: the base, then each slot's other candidates one at a time."""
    base = {s['name']: s['base'] for s in request['slots']}
    out = {'base': dict(base)}
    for s in request['slots']:
        for cid in s['candidates']:
            if cid != s['base']:
                out[cid] = {**base, s['name']: cid}
    return out


def sentences_of(request, picks):
    """[(words, claim body or None)] for one variant; empty sentences are left out."""
    chosen = {s['name']: s['candidates'][picks[s['name']]] for s in request['slots']}
    out = []
    for sentence in request['sentences']:
        words = re.sub(r'\{(\w+)\}', lambda m: chosen[m.group(1)]['text'], sentence['template'])
        if not words:
            continue
        claim = chosen[sentence['claim_from']]['claim'] if 'claim_from' in sentence else sentence.get('claim')
        if claim is None:
            raise Refusal(f'the sentence "{words}" has no claim: the picked candidate\'s claim is null, so only an empty sentence may have none')
        out.append((words, claim))
    return out


def main_of(request):
    """The old assemble.py main(), with its folders taken from the request: HERE holds lines/, lines.txt and
    manifest.json, NARRATOR holds shots/ and claims/ (the layout a film's narrator folder has)."""
    HERE, NARRATOR = request['out']['here'], request['out']['narrator']
    for sub in ('shots', 'claims'):
        os.makedirs(os.path.join(NARRATOR, sub), exist_ok=True)
    lines_dir = os.path.join(HERE, 'lines')
    os.makedirs(lines_dir, exist_ok=True)
    manifest = {}
    for vid, picks in picks_of(request).items():
        ss = sentences_of(request, picks)
        script = ' '.join(words for words, _ in ss)
        sid = f'{request["id_prefix"]}{vid.lower()}'
        about = {'variant': vid, 'picks': ', '.join(picks[s['name']] for s in request['slots']), 'id': sid}
        with open(os.path.join(lines_dir, f'{sid}.txt'), 'w', encoding='utf-8') as f:
            f.write(script + '\n')
        shot = {'id': sid, '_about': request['shot_about'].format(**about),
                'voice': {'script': request['script_path'].format(**about)}, 'screen': [], 'events': []}
        with open(os.path.join(NARRATOR, 'shots', f'{sid}.json'), 'w', encoding='utf-8') as f:
            json.dump(shot, f, ensure_ascii=False, indent=1)
        claims = {'_about': request['claims_about'].format(**about),
                  'voice': [{'words': words, 'kind': 'claim', **claim} if 'words' not in claim else dict(claim) for words, claim in ss],
                  'screen': []}
        with open(os.path.join(NARRATOR, 'claims', f'{sid}.json'), 'w', encoding='utf-8') as f:
            json.dump(claims, f, ensure_ascii=False, indent=1)
        manifest[vid] = {'shot': sid, 'slots': picks, 'line': script}
    with open(os.path.join(HERE, 'lines.txt'), 'w', encoding='utf-8') as f:
        for vid, m in manifest.items():
            f.write(m['line'] + '\n')
    with open(os.path.join(HERE, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print(len(manifest), 'variants written')
    return list(manifest)


def run(request):
    check(request)
    return main_of(request)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--request', action='append', help='a request JSON file (repeat it to lay later files over earlier ones, key by key); without it the request is read from standard input')
    a = ap.parse_args()
    try:
        request = load_request(a.request, tool='tool:make-spoken-line-candidates-one-slot-at-a-time')
        ids = run(request)
    except (Refusal, json.JSONDecodeError, OSError, KeyError, ValueError) as e:
        print(json.dumps({'error': str(e)}))
        return 2
    print(json.dumps({'result': {'variants': len(ids), 'ids': ids}}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
