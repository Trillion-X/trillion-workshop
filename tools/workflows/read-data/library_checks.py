"""Attach scoped, source-cited library applications to the existing checklist.

Library advice is evidence, never a universal instruction. The person's DATA names
source files/fields and explicit applications. Each applied row has a reason,
route, stage, question and verification; held rows remain visible and cannot pass.
The full current source row is in the definition pin, so changing a quotation,
claim, test or applicability invalidates an older answer automatically.
"""
from __future__ import annotations

import copy
import json
from gate_library import blake3_of, dotted_get, values_at
from library_applications import context_state, identity_of, live_source_current, pending_applications, record_applications

# Keep callers of the original optional application helpers on their shared owner.
source_identity_of = identity_of


def _words(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'library_checks requires non-empty {name}')
    return value


def _rows(lib, spec):
    path = lib.path_of(spec['file'])
    if path.suffix == '.jsonl':
        rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
    else:
        document = json.loads(path.read_text(encoding='utf-8'))
        if spec.get('row_groups'):
            groups = values_at(document, spec['row_groups'])
            if any(not isinstance(group, list) for group in groups):
                raise ValueError('library_checks row_groups must select arrays')
            rows = [row for group in groups for row in group]
        else:
            rows = dotted_get(document, spec['path']) if spec.get('path') else document
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError('library_checks sources must contain a list of objects')
    rows = [row for row in rows if all(dotted_get(row, key) == value for key, value in spec.get('where', {}).items())]
    return [row for row in rows if dotted_get(row, spec.get('fields', {}).get('id', 'id')) not in spec.get('exclude_ids', [])]


def with_library_checks(lib, base, application_rows=None):
    cfg = lib.section('library_checks')
    doc = copy.deepcopy(base)
    stages = {stage['id']: stage for stage in doc['stages']}
    used = {check['id'] for stage in doc['stages'] for check in stage['checks']}
    sources = {}
    for spec in cfg['sources']:
        fields = spec['fields']
        for row in _rows(lib, spec):
            identity = _words(dotted_get(row, fields['id']), 'source id')
            if identity in sources:
                raise ValueError(f'library_checks has duplicate source id {identity}')
            sources[identity] = (row, fields, spec.get('citation', {}), spec)
    selections = _rows(lib, cfg['applications']) if application_rows is None else application_rows
    context = context_state(lib)
    if context:
        selections = [row for row in selections if row.get('context_id') == context['id']]
    else:
        selections = [row for row in selections if row.get('context_id') is None]
    selected = set()
    coverage = {'available': len(sources), 'applied': [], 'held': [], 'not_applicable': [], 'unassessed': []}
    for selection in selections:
        identity = _words(selection.get('source_id'), 'source_id')
        if identity in selected:
            raise ValueError(f'library_checks repeats application {identity}')
        if identity not in sources:
            raise ValueError(f'library_checks source not found: {identity}')
        context_current = (not context or selection.get('assessed_context_identity') == context['identity']) and live_source_current(lib, sources[identity][0], sources[identity][3])
        if context and selection.get('disposition') == 'not-applicable' and (not context_current or selection.get('assessed_source_identity') != identity_of(sources[identity][0])):
            continue
        selected.add(identity)
        disposition = selection.get('disposition')
        if disposition not in ('apply', 'held', 'not-applicable'):
            raise ValueError(f'library_checks {identity} must be apply, held or not-applicable')
        because = _words(selection.get('because'), 'because')
        row, fields, citation, _ = sources[identity]
        canonical = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
        source_identity = blake3_of(canonical)
        assessed = context_current and selection.get('assessed_source_identity') == source_identity
        if disposition == 'not-applicable' and not assessed:
            raise ValueError(f'library_checks {identity}: applicability assessment is missing or stale; review the current source identity')
        if disposition == 'not-applicable':
            coverage['not_applicable'].append({'source_id': identity, 'because': because})
            continue
        stage = selection.get('stage')
        if stage not in stages:
            raise ValueError(f'library_checks {identity} names unknown stage {stage}')
        check_id = _words(selection.get('id'), 'check id')
        if check_id in used:
            raise ValueError(f'library_checks repeats check id {check_id}')
        used.add(check_id)
        claim = _words(dotted_get(row, fields['statement']), 'source statement')
        evidence = [row] if citation.get('row') is True else dotted_get(row, fields['sources'])
        if not isinstance(evidence, list) or not evidence:
            raise ValueError(f'library_checks {identity} has no source citations')
        support = selection.get('support') or {}
        cited = support.get('source_indices')
        def citation_present(index):
            ref = evidence[index]
            text = dotted_get(ref, citation.get('text', '')) if citation.get('text') else None
            locators = [dotted_get(ref, field) for field in citation.get('locators', [])]
            return isinstance(text, str) and bool(text.strip()) and any(isinstance(value, str) and bool(value.strip()) for value in locators)
        supported = (assessed and support.get('status') == 'supported'
                     and support.get('source_identity') == source_identity
                     and isinstance(support.get('assessment'), str) and bool(support['assessment'].strip())
                     and isinstance(cited, list) and bool(cited)
                     and all(isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(evidence) and citation_present(i) for i in cited))
        effective = disposition if disposition != 'apply' or supported else 'held'
        check = {'id': check_id, 'check': _words(selection.get('check'), 'check'),
                 'verify': _words(selection.get('verify'), 'verify'), 'must': True,
                 'routes': _words(selection.get('routes'), 'routes'), 'kind': 'source-cited application',
                 'library_application': {'source_id': identity, 'source_identity': source_identity,
                    'statement': claim, 'sources': evidence, 'because': because,
                    'disposition': effective, 'support': support, 'assessed_source_identity': selection.get('assessed_source_identity'),
                    **({'context': context} if context else {})}}
        if selection.get('per_option'):
            check['per_option'] = True
            check['rule_id'] = check_id
        if effective == 'held':
            # A held claim is still a required open question; nobody may mark it
            # passed before the application DATA resolves why it is held.
            check['library_application']['held_until'] = (_words(selection.get('held_until'), 'held_until') if disposition == 'held' else 'Review whether the current source supports this claim: supported status, assessment, cited source indexes with quotation and locator, and current source identities for both applicability and support are required. Quote presence is not support.')
        stages[stage]['checks'].append(check)
        coverage['applied' if effective == 'apply' else 'held'].append({'id': check_id, 'source_id': identity, 'because': because})
    coverage['unassessed'] = sorted(set(sources) - selected)
    doc['library_coverage'] = coverage
    doc['check_count'] = sum(len(stage['checks']) for stage in doc['stages'])
    doc['must_count'] = sum(bool(check['must']) for stage in doc['stages'] for check in stage['checks'])
    return doc
