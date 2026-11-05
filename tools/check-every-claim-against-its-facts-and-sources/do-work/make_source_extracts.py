#!/usr/bin/env python3 -I
"""Make the plain-text extract of every source in fact-gate/sources.json from its raw file.

The fact gate (tools/fact_gate.py) checks every quoted source wording against these extracts. Run this after
adding or re-fetching a source:  python3 -I tools/fact_sources.py
"""
import html
import json
import os
import re

GATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fact-gate')


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


def main():
    with open(os.path.join(GATE, 'sources.json')) as f:
        sources = json.load(f)['sources']
    for sid, s in sources.items():
        if s['extract'] not in EXTRACT:
            # Kinds whose extract is made by their own tool (whisper-words, text): keep it, refuse if it is missing.
            out = os.path.join(GATE, s['text'])
            if not os.path.exists(out):
                raise SystemExit(f'{sid}: extract kind {s["extract"]!r} has no builder here and {out} is missing')
            print(f'{sid}: kept its own {s["extract"]} extract -> {os.path.normpath(out)}')
            continue
        with open(os.path.join(GATE, s['raw']), encoding='utf-8', errors='replace') as f:
            text = EXTRACT[s['extract']](f.read())
        out = os.path.join(GATE, s['text'])
        if os.path.abspath(out) != os.path.abspath(os.path.join(GATE, s['raw'])):
            with open(out, 'w') as f:
                f.write(text)
        print(f'{sid}: {len(text)} chars -> {os.path.normpath(out)}')


if __name__ == '__main__':
    main()
