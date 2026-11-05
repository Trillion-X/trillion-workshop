#!/usr/bin/env python3 -I
"""Make the plain-text extract of every source in a sources file from its raw file.

The claim check (check_claims.py) checks every quoted source wording against these extracts. Run this after adding or
re-fetching a source. One JSON request on standard input: {"sources": "<the sources file>"}. Each source names its
`raw` file and its `text` extract (both relative to the sources file's folder, or absolute) and its `extract` kind:
html, fdc-json (a FoodData Central food), new-order (an edit plan's new_order rows) or copy. A kind with no builder here
(made by its own tool, such as whisper-words or text) keeps its extract and is refused when it is missing.
Answer: {"result": {"sources": [{"id", "text", "chars" | "kept"}]}} or {"error": "what to change"}.

Ported one to one from a film repository's narrator/tools/fact_sources.py; the folder is the request's sources file
instead of where the script sat.
"""
import html
import json
import os
import re
import sys


def from_html(raw):
    raw = re.sub(r'(?s)<script.*?</script>|<style.*?</style>', ' ', raw)
    return ' '.join(html.unescape(re.sub(r'<[^>]+>', ' ', raw)).split()) + '\n'


def from_fdc_json(raw):
    food = json.loads(raw)
    lines = [f'{food["description"]} (FDC ID {food["fdcId"]}), amounts per 100 g']
    for n in food['foodNutrients']:
        if 'amount' in n:
            lines.append(f'{n["nutrient"]["name"]}: {n["amount"]:g} {n["nutrient"]["unitName"]}')
    return '\n'.join(lines) + '\n'


def from_new_order(raw):
    plan = json.loads(raw)
    lines = []
    for row in plan['new_order']:
        lines.append(f'{row["id"]}: {row["clip"]} {row["src_in"]:g}-{row["src_out"]:g}, dur {row["dur"]:g} s, '
                     f'inner cuts {row["inner_cut_s"]:g} s ({row["note"]})')
    return '\n'.join(lines) + '\n'


EXTRACT = {'html': from_html, 'fdc-json': from_fdc_json, 'new-order': from_new_order, 'copy': lambda raw: raw}


def make(sources_file):
    gate = os.path.dirname(os.path.abspath(sources_file))
    with open(sources_file) as f:
        sources = json.load(f)['sources']
    done = []
    for sid, s in sources.items():
        out = os.path.join(gate, s['text'])
        if s['extract'] not in EXTRACT:
            # Kinds whose extract is made by their own tool (whisper-words, text): keep it, refuse if it is missing.
            if not os.path.exists(out):
                raise SystemExit(f'{sid}: extract kind {s["extract"]!r} has no builder here and {out} is missing')
            print(f'{sid}: kept its own {s["extract"]} extract -> {os.path.normpath(out)}', file=sys.stderr)
            done.append({'id': sid, 'text': os.path.normpath(out), 'kept': True})
            continue
        with open(os.path.join(gate, s['raw']), encoding='utf-8', errors='replace') as f:
            text = EXTRACT[s['extract']](f.read())
        if os.path.abspath(out) != os.path.abspath(os.path.join(gate, s['raw'])):
            with open(out, 'w') as f:
                f.write(text)
        print(f'{sid}: {len(text)} chars -> {os.path.normpath(out)}', file=sys.stderr)
        done.append({'id': sid, 'text': os.path.normpath(out), 'chars': len(text)})
    return done


def main():
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict) or not isinstance(request.get('sources'), str):
            raise SystemExit('send {"sources": "<the sources file>"} on standard input')
        print(json.dumps({'result': {'sources': make(request['sources'])}}))
        return 0
    except (SystemExit, OSError, json.JSONDecodeError, KeyError) as e:
        print(json.dumps({'error': str(e) if not isinstance(e, KeyError) else f'a source lacks {e}'}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
