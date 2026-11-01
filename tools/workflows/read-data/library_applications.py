"""Resume scoped source assessments in the existing checklist applications DATA.

This is a projection and mutation of that owner, never another queue. Directory
flocks serialize cooperating application writers across library roots. They are
not atomic CAS against arbitrary edits to source files or remote account rows.
"""
from __future__ import annotations

import fcntl
import json
import os
from datetime import datetime, timezone

from gate_library import blake3_of, dotted_get, file_blake3, write_json


def words(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'library applications require non-empty {name}')
    return value


def identity_of(row):
    return blake3_of(json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())


def context_state(lib):
    context = lib.section('library_checks').get('context')
    if context is None:
        return None
    words(context.get('id'), 'context id')
    targets = context.get('targets')
    if not isinstance(targets, list) or not targets:
        raise ValueError('library_checks context requires target files')
    pins = [{'file': words(path, 'context target'), 'identity': file_blake3(lib.path_of(path))} for path in targets]
    return {'id': context['id'], 'identity': identity_of({'context': context, 'targets': pins}), 'targets': pins}


def live_source_current(lib, row, spec):
    """Validate an optional genuine connector read receipt; never fetch remotely.

    Receipt structure does not authenticate its author. The caller owns the real
    connector read. Without live_snapshot the source is explicitly offline only.
    """
    live = spec.get('live_snapshot')
    if not live:
        return True
    try:
        receipt = json.loads(lib.path_of(live['file']).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return False
    stamp = datetime.fromisoformat(words(dotted_get(receipt, live['at']), 'live read timestamp').replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        raise ValueError('live read timestamp requires a time zone')
    maximum = live['max_age_seconds']
    if type(maximum) not in (int, float) or maximum <= 0:
        raise ValueError('live_snapshot max_age_seconds must be positive')
    age = (datetime.now(timezone.utc) - stamp).total_seconds()
    if not 0 <= age <= maximum:
        return False
    records = dotted_get(receipt, live['records'])
    if not isinstance(records, list):
        raise ValueError('live_snapshot records must select an array')
    return dotted_get(row, live.get('source_record_path', '')) in records


def source_rows(lib):
    from library_checks import _rows
    sources = {}
    for spec in lib.section('library_checks')['sources']:
        for row in _rows(lib, spec):
            identity = words(dotted_get(row, spec['fields']['id']), 'source id')
            if identity in sources:
                raise ValueError(f'library_checks has duplicate source id {identity}')
            sources[identity] = (row, spec)
    return sources


def pending_applications(lib, limit=8, source_ids=None):
    from library_checks import _rows
    if type(limit) is not int or not 1 <= limit <= 256:
        raise ValueError('application batch limit must be an integer from 1 through 256')
    cfg = lib.section('library_checks')
    context = context_state(lib)
    if not context:
        raise ValueError('library-pending requires library_checks.context')
    selected = {}
    for app in _rows(lib, cfg['applications']):
        if app.get('context_id') != context['id']:
            continue
        identity = words(app.get('source_id'), 'source_id')
        if identity in selected:
            raise ValueError(f'duplicate application {identity} in context {context["id"]}')
        selected[identity] = app
    pending, held, assessed = [], [], 0
    sources = source_rows(lib)
    for identity, (row, spec) in sources.items():
        pin = identity_of(row)
        prior = selected.get(identity)
        current = prior and prior.get('assessed_source_identity') == pin and prior.get('assessed_context_identity') == context['identity'] and live_source_current(lib, row, spec)
        if current:
            if prior.get('disposition') == 'held':
                held.append(identity)
            else:
                assessed += 1
        else:
            pending.append({'source_id': identity, 'source_identity': pin, 'prior_identity': identity_of(prior), 'row': row})
    pending.sort(key=lambda row: row['source_id'])
    candidates = pending
    if source_ids is not None:
        requested = set(source_ids)
        if requested - sources.keys():
            raise ValueError('requested source ids not found: ' + ', '.join(sorted(requested - sources.keys())))
        candidates = [row for row in pending if row['source_id'] in requested]
    return {'context': context, 'available': len(sources), 'assessed': assessed,
            'held_count': len(held), 'held': sorted(held)[:limit], 'pending_count': len(pending),
            'batch': candidates[:limit], 'remaining_after_batch': len(pending) - min(limit, len(candidates)),
            'source_freshness': 'Configured live snapshots require a matching recent connector receipt; other sources are local snapshots only.'}


def record_applications(lib, submission, remove=False):
    if lib.read_only:
        raise ValueError('cannot record applications with --read-only')
    path = lib.path_of(lib.section('library_checks')['applications']['file'])
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        return _record_applications(lib, submission, remove)
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _record_applications(lib, submission, remove):
    from library_checks import _rows, with_library_checks
    cfg = lib.section('library_checks')
    context = context_state(lib)
    if not context or submission.get('context_identity') != context['identity']:
        raise ValueError('work context changed; fetch library-pending again')
    by = words(submission.get('by'), 'assessment author')
    judgments = submission.get('judgments')
    if not isinstance(judgments, list) or not 1 <= len(judgments) <= 256:
        raise ValueError('assessment requires 1 through 256 judgments')
    spec = cfg['applications']
    if spec.get('path') or lib.path_of(spec['file']).suffix == '.jsonl':
        raise ValueError('record applications requires a JSON array file; nested/JSONL owners remain read-only')
    current = _rows(lib, spec)
    sources = source_rows(lib)
    updates, seen = {}, set()
    for judgment in judgments:
        identity = words(judgment.get('source_id'), 'source_id')
        if identity in seen:
            raise ValueError(f'repeated assessment {identity}')
        seen.add(identity)
        prior = [app for app in current if app.get('context_id') == context['id'] and app.get('source_id') == identity]
        if len(prior) > 1:
            raise ValueError(f'duplicate current assessment: {identity}')
        if remove:
            words(judgment.get('because'), 'removal reason')
            if prior and judgment.get('prior_identity') != identity_of(prior[0]):
                raise ValueError(f'application changed: {identity}; fetch library-pending again')
            updates[identity] = None
            continue
        if identity not in sources or judgment.get('assessed_source_identity') != identity_of(sources[identity][0]):
            raise ValueError(f'source changed: {identity}; fetch library-pending again')
        if not live_source_current(lib, *sources[identity]):
            raise ValueError(f'fresh live source read required: {identity}')
        app = {key: value for key, value in judgment.items() if key != 'prior_identity'}
        app.update(context_id=context['id'], assessed_context_identity=context['identity'], assessed_by=by)
        review = app.get('review') or {}
        words(review.get('assessment'), 'source-context assessment')
        words(review.get('evidence'), 'source-context evidence locator')
        if prior and prior[0] == app:
            continue
        if judgment.get('prior_identity') != identity_of(prior[0] if prior else None):
            raise ValueError(f'application changed: {identity}; fetch library-pending again')
        updates[identity] = app
    merged = [updates.pop(app.get('source_id'), app) if app.get('context_id') == context['id'] else app for app in current]
    merged.extend(updates.values())
    merged = [app for app in merged if app is not None]
    composed = with_library_checks(lib, lib.file(lib.schema['checklist']), application_rows=merged)
    held_ids = {row['source_id'] for row in composed['library_coverage']['held']}
    if not remove and any(j['source_id'] in held_ids and j.get('disposition') == 'apply' for j in judgments):
        raise ValueError('an applied judgment lacks current source support; record an explicit held judgment')
    if context_state(lib) != context:
        raise ValueError('work context changed during assessment; fetch library-pending again')
    if _rows(lib, spec) != current:
        raise ValueError('applications changed during assessment; fetch library-pending again')
    if not remove:
        latest = source_rows(lib)
        if any(j['source_id'] not in latest or identity_of(latest[j['source_id']][0]) != j['assessed_source_identity'] or not live_source_current(lib, *latest[j['source_id']]) for j in judgments):
            raise ValueError('source changed during assessment; fetch library-pending again')
    write_json(lib.path_of(spec['file']), merged)
    if _rows(lib, spec) != merged:
        raise ValueError('application readback differs')
    return {'written': str(lib.path_of(spec['file'])), 'context': context,
            'removed' if remove else 'recorded': sorted(seen), 'pending': pending_applications(lib)}
