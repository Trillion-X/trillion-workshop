"""The checklist document, generated from the person's own checklist text and checked for what a hand edit or a typo breaks.

A checklist document is `{ ...header, delivery_stages, default_delivery_stage, check_count, must_count, stages: [{ id, name, <stage fields>, checks: [check] }] }`
and a check is `{ id, check, routes, verify, kind, must, ...flags }`. The person's text holds one section per stage and one table row per check; the schema's
`checklist_source` says how to read it, so a person with another layout changes the schema, not this code:

  file            the text file, from the library root
  header          the constant fields the document starts with (statuses, verdicts, phases...), kept in this order
  stage           { pattern: regex with three groups (id, name, body) , fields: { document field: "Label" } } where body holds `**Label:** a; b` lines
  delivery        { pattern: regex with one group: "name = words; name = words. ...", default: the stage a run names when it names none }
  rule_source     { pattern: regex with one group (a file path, from the library root), rows_path, id_field, rule_field, kinds_field, kind }: the file the
                  rule wording of a rule-backed row is read from, never copied into the text
  row_kinds       [{ pattern, fields, adds, covers_rule_source? }]: a table row matching `pattern` becomes a check; `fields` name its regex groups in order
                  (`must` reads yes/no); `adds` lists [field, value] in order, a value being a literal, { field }, { rule_text } (the rule's wording, refused when
                  the rule source has none) or { source_ref } (the rule source's path and the rule's id)
  notes           [{ pattern, target_flag, set, missing, unknown_stage? }]: a line that annotates the check it names (the first group) and sets fields on it
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from gate_library import Library, phase_check_id, read_json
from gate_pieces import route_applies


def _value(spec, row: dict, rule_text: dict, rule_path: str | None) -> object:
    if not isinstance(spec, dict):
        return spec
    if 'field' in spec:
        return row[spec['field']]
    if 'rule_text' in spec:
        return rule_text[row[spec['rule_text']]]
    if 'source_ref' in spec:
        return f'{rule_path}#rows[{row[spec["source_ref"]]}]'
    raise ValueError(f'a checklist_source value must be a literal, {{ field }}, {{ rule_text }} or {{ source_ref }}: {json.dumps(spec)}')


def generate(lib: Library) -> dict:
    """The checklist document the person's text generates."""
    src = lib.section('checklist_source')
    text = lib.path_of(src['file']).read_text(encoding='utf-8')
    rule_source = re.search(src['rule_source']['pattern'], text) if src.get('rule_source') else None
    rule_text: dict[str, str] = {}
    if rule_source:
        rs = src['rule_source']
        rows = read_json(lib.path_of(rule_source.group(1)))[rs['rows_path']]
        rule_text = {r[rs['id_field']]: r[rs['rule_field']] for r in rows if rs['kind'] in r[rs['kinds_field']]}
    delivery_line = re.search(src['delivery']['pattern'], text, re.M)
    delivery = dict(x.split(' = ', 1) for x in re.split(r'; (?=[a-z]+ = )', delivery_line.group(1).split('. ')[0])) if delivery_line else {}
    default_stage = src['delivery']['default']
    if delivery and default_stage not in delivery:
        raise ValueError(f'"Delivery stages" must define {default_stage} (the stage a gate run names by default)')
    stages = []
    covered: set[str] = set()
    for m in re.finditer(src['stage']['pattern'], text, re.M | re.S):
        sid, name, body = m.group(1), m.group(2), m.group(3)
        checks = []
        for kind in src['row_kinds']:
            for row in re.finditer(kind['pattern'], body, re.M):
                got = {field: row.group(i + 1) for i, field in enumerate(kind['fields'])}
                check = {f: (got[f] == 'yes' if f == 'must' else got[f]) for f in kind['fields'] if f in ('id', 'check', 'routes', 'verify', 'kind', 'must')}
                rid = got.get('rule_id')
                if kind.get('covers_rule_source') and rid not in rule_text:
                    raise ValueError(f'{got["id"]} names rule {rid}, which is not in {rule_source.group(1) if rule_source else "any rule source"}')
                for field, spec in kind.get('adds', []):
                    check[field] = _value(spec, got, rule_text, rule_source.group(1) if rule_source else None)
                if kind.get('covers_rule_source'):
                    covered.add(rid)
                checks.append(check)
        for note in src.get('notes', []):
            for row in re.finditer(note['pattern'], body, re.M):
                target = next((c for c in checks if c['id'] == row.group(1) and (not note.get('target_flag') or c.get(note['target_flag']))), None)
                stages_named = [x.strip() for x in row.group(note['stages_group']).split(',')] if 'stages_group' in note else []
                if not target or (stages_named and set(stages_named) - set(delivery)):
                    raise ValueError(note['refusal'].format(id=row.group(1), stage=sid, stages=stages_named, known=sorted(delivery)))
                for field, spec in note['set']:
                    target[field] = [x.strip() for x in row.group(spec['group']).split(',')] if isinstance(spec, dict) and spec.get('split') else (row.group(spec['group']) if isinstance(spec, dict) else spec)
        stage = {'id': sid, 'name': name}
        for field, label in src['stage']['fields'].items():
            f = re.search(r'\*\*' + re.escape(label) + r':\*\* (.+)', body)
            stage[field] = [x.strip() for x in f.group(1).split(';')] if f else []
        stage['checks'] = checks
        stages.append(stage)
    if rule_source and covered != set(rule_text):
        raise ValueError(f'rules with no checklist row: {sorted(set(rule_text) - covered)}')
    n = sum(len(s['checks']) for s in stages)
    return {**src['header'], 'delivery_stages': delivery, 'default_delivery_stage': default_stage,
            'check_count': n, 'must_count': sum(c['must'] for s in stages for c in s['checks']), 'stages': stages}


def compare(lib: Library, generated: dict, on_disk_path: Path) -> str | None:
    """None when the file on disk is exactly what the text generates; otherwise what differs, in words."""
    on_disk = json.loads(on_disk_path.read_text(encoding='utf-8'))
    if on_disk == generated:
        return None

    def rows(d):
        return {c['id']: c for s in d.get('stages', []) for c in s['checks']}
    have, want = rows(on_disk), rows(generated)
    source = lib.section('checklist_source')['file']
    return (f'{on_disk_path} is not what {source} generates. Only in the generated file: {sorted(set(have) - set(want))}; only in {source}: {sorted(set(want) - set(have))}; '
            f'differing: {sorted(i for i in set(have) & set(want) if have[i] != want[i])}{"" if have != want else "; stage or header fields differ"}. Edit {source} and regenerate.')


def checklist_problems(lib: Library, doc: dict) -> list[str]:
    """Every plain-words problem with a checklist document, whoever wrote it: repeated ids, a must that is not true or false, a route with a tag the schema
    does not know, a per-item check with no rule id, an advisory stage that is not a delivery stage, a phase that names no check, counts that do not add up."""
    problems: list[str] = []
    seen: dict[str, str] = {}
    known_tags = lib.schema.get('checklist_source', {}).get('known_route_tags')
    stages_named = set(doc.get('delivery_stages', {}))
    ids = {c['id'] for s in doc.get('stages', []) for c in s['checks']}
    for s in doc.get('stages', []):
        for c in s['checks']:
            where = f'{c.get("id", "?")} in {s["id"]}'
            if c.get('id') in seen:
                problems.append(f'{where} repeats the id of a check in {seen[c["id"]]}.')
            seen[c.get('id')] = s['id']
            for field in ('id', 'check', 'routes', 'verify', 'kind'):
                if not isinstance(c.get(field), str) or not c[field].strip():
                    problems.append(f'{where} has no {field}.')
            if not isinstance(c.get('must'), bool):
                problems.append(f'{where}: must is true or false.')
            if c.get('per_option') and not c.get('rule_id'):
                problems.append(f'{where} is answered per item but names no rule_id.')
            if isinstance(c.get('routes'), str):
                if known_tags is not None:
                    unknown = sorted({t for t in re.findall(r'[a-z][a-z:]*', re.sub(r'\bnot\b', '', c['routes'])) if t not in known_tags and not t.startswith('data:')})
                    if unknown:
                        problems.append(f'{where} routes on {", ".join(unknown)}, which the schema does not list as route tags.')
                try:
                    route_applies(c['routes'], set())
                except Exception as exc:  # a route expression no reader can evaluate
                    problems.append(f'{where}: route "{c["routes"]}" cannot be read ({exc}).')
            for stage in c.get('advisory_passes_at', []):
                if stage not in stages_named:
                    problems.append(f'{where}: advisory_passes_at names {stage}, which is not a delivery stage ({", ".join(sorted(stages_named))}).')
    default = doc.get('default_delivery_stage')
    if stages_named and default not in stages_named:
        problems.append(f'default_delivery_stage {default} is not one of the delivery stages ({", ".join(sorted(stages_named))}).')
    for phase in doc.get('publish_phase', []) + doc.get('after_phase', []):
        named = phase_check_id(phase, ids)
        if named is None:
            problems.append(f'phase entry "{phase}" names no check of the checklist.')
    if doc.get('check_count') != len(ids) and len(seen) == len(ids):
        problems.append(f'check_count says {doc.get("check_count")} but the stages hold {len(ids)} checks.')
    if doc.get('must_count') != sum(1 for s in doc.get('stages', []) for c in s['checks'] if c.get('must') is True):
        problems.append(f'must_count says {doc.get("must_count")} but the stages hold {sum(1 for s in doc.get("stages", []) for c in s["checks"] if c.get("must") is True)} required checks.')
    return problems
