"""Adopt a saved, reviewed packet of picture evidence into the files that own it.

Two adoptions, both refusing before any write unless every file they name still has the bytes it was pinned with:

  * `adopt_intervals`: reviewed picture intervals become rows of the person's timeline table, tokens and slots of the person's
    word template, and an answer in the piece's investigation record. Existing tokens, slots, lines and memberships must come out
    unchanged, unless a declared migration moves a whole record from the piece to a unit.
  * `adopt_source_evidence_only`: review evidence is attached to the template spec by changing one object's members in place (every
    other byte of the spec stays) and the piece's answer is refreshed without changing its status, label or flags. The exact
    preimage of both files is kept, and the receipt proves a byte inverse exists.

A recorded adoption establishes structure and file identity; it never marks audiovisual review complete.

Every name of the person's own (table file and columns, reader and dimension ids, slot types and rules, the spec member that holds
evidence, schema labels, receipt file names, the question an adoption answers) comes in the `adoption` profile of the library's
schema; this file holds none of them. The word template's readers and tokenizer are the public modules of the Workshop tool
fill-a-template-without-changing-its-words.
"""
from __future__ import annotations

import copy
import csv
import io
import json
import math
import os
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

import frame_evidence
import investigation
from json_patch import patch_object_members
from library import Store, content_identity, read_json, write_json

TEMPLATE_READ_DATA = Path(__file__).resolve().parents[2] / 'fill-a-template-without-changing-its-words' / 'read-data'


def template_modules():
    """The word template's readers and tokenizer, imported when an adoption needs them."""
    if str(TEMPLATE_READ_DATA) not in sys.path:
        sys.path.insert(0, str(TEMPLATE_READ_DATA))
    import wt_core
    import wt_ops
    return wt_core, wt_ops


REQUIRED = (
    'registry', 'vocabulary', 'spec_file', 'evidence_key', 'evidence_fields.journal_paths', 'evidence_fields.retained_paths',
    'evidence_fields.retained_reviews', 'review_kinds.finalized', 'review_kinds.retained', 'finalized_qualification',
    'retained_qualification', 'frame_ledger.ledger_file', 'frame_ledger.lessons_file', 'frame_ledger.artifact',
    'table.file', 'table.reader', 'table.id_column', 'table.id_prefix', 'table.id_width', 'table.start', 'table.end',
    'table.duration', 'table.transition', 'table.evidence', 'table.scope', 'table.unknown', 'table.coverage_key',
    'table.coverage_text', 'scene_slot.id_prefix', 'scene_slot.type', 'scene_slot.rule', 'scene_slot.dims', 'scene_slot.note',
    'word.reader', 'word.line_dim', 'word.slot_type', 'word.rule', 'word.slot_note', 'word.method', 'word.time_semantics',
    'files.journal', 'files.detail', 'files.detail_note', 'files.input_copy', 'files.readback', 'files.membership_readback',
    'files.before_table', 'files.before_spec', 'files.before_table_absent', 'membership_mode', 'question.id', 'question.status',
    'question.label', 'question.note', 'source_evidence_only.schema', 'source_evidence_only.readback_schema',
    'source_evidence_only.before_spec', 'source_evidence_only.before_investigation', 'source_evidence_only.receipt',
    'source_evidence_only.pending_suffix', 'source_evidence_only.preservation')


def check_profile(profile: Any) -> dict:
    """Refuse an adoption profile that lacks a name this file would need."""
    missing = []
    for dotted in REQUIRED:
        node = profile
        for key in dotted.split('.'):
            node = node.get(key) if isinstance(node, dict) else None
        if node in (None, '', []):
            missing.append(dotted)
    if missing:
        raise ValueError(f'The schema\'s adoption profile must name: {", ".join(missing)}')
    return profile


def append_pinned_line(spec, dimension, token_ids):
    """Expose new records when this dimension already has explicit lines."""
    lines = spec.get('lines', {})
    if dimension not in lines or not token_ids:
        return
    definitions = lines[dimension]
    if any(line.get('from') == token_ids[0] and line.get('to') == token_ids[-1]
           for line in definitions):
        return
    prefix = dimension + ':L'
    used = {line['id'] for line in definitions}
    ordinal = max((int(identity[len(prefix):]) for identity in used
                   if identity.startswith(prefix) and identity[len(prefix):].isdigit()), default=0) + 1
    definitions.append({'id': f'{prefix}{ordinal}', 'from': token_ids[0],
                        'to': token_ids[-1], 'job': None})


def _validate_vocabulary(rows, vocabulary):
    """Validate list members after trimming while retaining the authored row values."""
    for row in rows:
        for key, rule in vocabulary.items():
            value = row.get(key, 'unknown')
            if 'one_of' in rule and value not in rule['one_of']:
                raise ValueError(f'Invalid {key}: {value}')
            if 'list_of' in rule and any(v.strip() not in rule['list_of'] for v in value.split(',')):
                raise ValueError(f'Invalid {key}: {value}')
            if rule.get('number') and key in row:
                try:
                    finite = math.isfinite(float(value))
                except (TypeError, ValueError):
                    finite = False
                if not finite:
                    raise ValueError(f'Invalid {key}: {value}')


def _existing_scene_slots(P, slots):
    """Find scene-content slots by meaning, independent of authored ID prefixes."""
    return {
        tuple(slot['tokens']): slot for slot in slots
        if slot.get('type') == P['scene_slot']['type']
        and set(slot.get('dims') or ()) == set(P['scene_slot']['dims'])
    }


def _reader_source_orders(source_records, overrides):
    """Return positions matching the template tokenizer's explicit-order branch.

    The tokenizer replaces authored overrides at their source positions and lets an override's explicit record_order win. New
    membership pins therefore use base reader positions, while existing explicit orders remain authoritative.
    """
    orders = {}
    explicit = []
    override_by_id = {record.get('id'): record for record in overrides}
    source_positions = {record.get('id'): index for index, record in enumerate(source_records)}
    for index, record in enumerate(source_records):
        identity = record.get('id')
        override = override_by_id.get(identity)
        if override is not None and 'record_order' not in override:
            # The tokenizer replaces the raw row, then falls back to that row's source position when the override has no order.
            order = index
        elif override is not None:
            order = override['record_order']
        elif 'record_order' in record:
            order = record['record_order']
        else:
            order = index
        if 'record_order' in (override or record):
            if not isinstance(order, int) or isinstance(order, bool) or order < 0:
                raise ValueError('Reader source record_order values must be nonnegative integers')
            explicit.append(order)
        orders[identity] = order
    next_order = len(source_records)
    for index, record in enumerate(overrides):
        identity = record.get('id')
        if identity not in source_positions:
            orders.setdefault(identity, next_order + index)
        if 'record_order' in record:
            order = record['record_order']
            if not isinstance(order, int) or isinstance(order, bool) or order < 0:
                raise ValueError('Reader override record_order values must be nonnegative integers')
            if identity not in source_positions:
                explicit.append(order)
            orders[identity] = order
    if len(explicit) != len(set(explicit)):
        raise ValueError('Reader record_order values must be unique')
    return orders


def _validate_declared_frame_links(P, spec, piece, root):
    """Check retained frame records explicitly linked by the existing evidence spec.

    A spec without a frame ledger stays valid. When one is declared in the evidence member, its paired lesson file is required
    and every ledger image is verified against its recorded BLAKE3 identity and length. The ledger is the per-frame observation
    note; its half-open range must match the linked lesson's declared reviewed range when present.
    """
    ledger_name, lessons_name, artifact = (P['frame_ledger'][k] for k in ('ledger_file', 'lessons_file', 'artifact'))
    evidence = (spec.get('piece') or {}).get(P['evidence_key']) or {}
    if not isinstance(evidence, dict):
        return
    declared = [evidence.get('path'), *(evidence.get('additional_paths') or [])]
    paths = []
    for raw in declared:
        if not isinstance(raw, str) or not raw.strip():
            continue
        candidate = Path(raw)
        candidate = candidate if candidate.is_absolute() else piece / candidate
        paths.append((candidate.resolve(), raw))
    ledgers = [path for path, _ in paths if path.name == ledger_name]
    if not ledgers:
        return
    lessons = [path for path, _ in paths if path.name == lessons_name]
    for path in (*ledgers, *lessons):
        if not path.is_relative_to(root.resolve()):
            raise ValueError(f'Declared frame evidence escapes source root: {path}')
    if not lessons:
        raise ValueError(f'A declared {ledger_name} requires a linked {lessons_name}')
    for ledger_path in ledgers:
        if not ledger_path.is_file():
            raise ValueError(f'Missing declared frame ledger: {ledger_path}')
        ledger = read_json(ledger_path)
        if (ledger.get('artifact') != artifact or
                not isinstance(ledger.get('frames'), list) or not ledger['frames']):
            raise ValueError(f'Invalid declared frame ledger: {ledger_path}')
        seen = set()
        frame_indices = []
        for frame in ledger['frames']:
            index = frame.get('index')
            if not isinstance(index, int) or isinstance(index, bool) or index < 0 or index in seen:
                raise ValueError(f'Invalid or duplicate frame index in {ledger_path}: {index!r}')
            seen.add(index)
            frame_indices.append(index)
            raw_path = frame.get('path')
            identity = frame.get('identity')
            if not isinstance(raw_path, str) or not raw_path:
                raise ValueError(f'Missing retained image path for frame {index} in {ledger_path}')
            image_path = Path(raw_path)
            image_path = image_path if image_path.is_absolute() else ledger_path.parent / image_path
            image_path = image_path.resolve()
            if not image_path.is_relative_to(root.resolve()) or not image_path.is_file():
                raise ValueError(f'Missing or out-of-root retained image for frame {index}: {image_path}')
            if not isinstance(identity, dict) or identity.get('algorithm') != 'blake3':
                raise ValueError(f'Missing BLAKE3 identity for retained frame {index} in {ledger_path}')
            actual = content_identity(image_path)
            if actual != identity:
                raise ValueError(f'Retained image identity mismatch for frame {index}: {image_path}')
        if frame_indices and frame_indices != sorted(frame_indices):
            raise ValueError(f'Frame ledger indices are not in source order: {ledger_path}')
        matching_lessons = []
        source_mismatch = False
        range_mismatch = False
        for lesson_path in lessons:
            if not lesson_path.is_file():
                raise ValueError(f'Missing linked moment lesson: {lesson_path}')
            lesson = read_json(lesson_path)
            source = lesson.get('source') if isinstance(lesson, dict) else None
            reviewed = source.get('reviewed_half_open_frames') if isinstance(source, dict) else None
            ledger_source = ledger.get('source')
            lesson_source = source.get('video_id') if isinstance(source, dict) else None
            if ledger_source is not None and lesson_source is not None and ledger_source != lesson_source:
                source_mismatch = True
                continue
            if reviewed is not None and frame_indices:
                if (not isinstance(reviewed, list) or len(reviewed) != 2 or
                        any(not isinstance(value, int) or isinstance(value, bool) for value in reviewed) or
                        reviewed != [frame_indices[0], frame_indices[-1] + 1]):
                    range_mismatch = True
                    continue
            matching_lessons.append(lesson_path)
        if not matching_lessons:
            if source_mismatch and not range_mismatch:
                raise ValueError(f'Lesson source does not match declared frame ledger: {ledger_path}')
            if range_mismatch:
                raise ValueError(f'Lesson frame range does not match declared ledger: {ledger_path}')
            raise ValueError(f'No linked moment lesson matches declared frame ledger: {ledger_path}')


def _validate_page_journals(P, spec, piece, journal_path, root):
    """Run strict page-journal validation only for the declared journal schema and paths."""
    evidence = (spec.get('piece') or {}).get(P['evidence_key']) or {}
    if not isinstance(evidence, dict):
        evidence = {}
    field = P['evidence_fields']['journal_paths']
    declared = evidence.get(field, [])
    if isinstance(declared, str):
        declared = [declared]
    if not isinstance(declared, list) or any(not isinstance(raw, str) or not raw.strip() for raw in declared):
        raise ValueError(f'{field} must be a list of nonempty paths')
    current = read_json(journal_path)
    strict_current = current.get('schema') == P['frame_evidence']['journal_schema']
    if not strict_current and not declared:
        return
    paths = []
    if strict_current:
        paths.append(journal_path.resolve())
    for raw in declared:
        candidate = Path(raw)
        candidate = candidate if candidate.is_absolute() else piece / candidate
        candidate = candidate.resolve()
        if not candidate.is_relative_to(root.resolve()):
            raise ValueError(f'Declared page journal escapes source root: {candidate}')
        if candidate not in paths:
            paths.append(candidate)
    for path in paths:
        frame_evidence.validate_page_journal(path, P['frame_evidence'])


def _preflight_recordable_paths(files, generated=()):
    """Refuse missing evidence inputs before adoption writes any owner.

    Some evidence is produced by the adoption itself. For those paths, verify their destination directory and reject a
    conflicting non-file target; all other paths must already be regular files, matching record_evidence's existence check.
    This is a preflight, not a claim that later I/O failures are transactional.
    """
    generated = {Path(path).resolve() for path in generated}
    for raw in files:
        path = Path(raw).expanduser().resolve()
        if path in generated:
            if not path.parent.is_dir():
                raise ValueError(f'Missing evidence output directory: {path.parent}')
            if path.exists() and not path.is_file():
                raise ValueError(f'Evidence output is not a file: {path}')
        elif not path.is_file():
            raise ValueError(f'Missing required review or recordable evidence file: {path}')


def _token_snapshot(P, spec, rows, fields, registry, root):
    """Read prospective memberships through the declared template readers/tokenizer."""
    _, wt_ops = template_modules()
    source = spec.get('sources', {}).get(P['table']['reader'])
    if not isinstance(source, dict) or not source.get('id_column'):
        raise ValueError(f'Membership preservation requires a declared {P["table"]["reader"]} id_column')
    id_column = source['id_column']
    if fields.count(id_column) != 1 or any(not row.get(id_column) for row in rows):
        raise ValueError('Membership preservation requires unique nonempty TSV row identities')
    with tempfile.TemporaryDirectory(prefix='reviewed-window-membership-') as temporary:
        path = Path(temporary) / P['table']['file']
        with path.open('w', encoding='utf-8', newline='') as stream:
            writer = csv.DictWriter(stream, fields, delimiter='\t', lineterminator='\n')
            writer.writeheader()
            writer.writerows(rows)
        prospective = copy.deepcopy(spec)
        prospective['sources'][P['table']['reader']]['path'] = str(path)
        piece = wt_ops.tokenize(prospective, registry, root=root)
    return {
        'tokens': {token['id']: token for token in piece['tokens']},
        'lines': piece['lines'],
        'slots': piece['slots'],
    }


def _pin_implicit_memberships(spec, tokens, registry, root, skip_records=None):
    """Pin old implicit piece memberships in the readers that produced their records."""
    wt_core, _ = template_modules()
    read_source, expand, split_words = wt_core.read_source, wt_core.expand, wt_core.split_words
    skip_records = skip_records or set()
    dims = registry.dims
    readers = set(spec.get('records', {}))
    for row in dims.values():
        for measure in row.get('measure') or []:
            measures = [measure] if isinstance(measure, dict) else measure
            readers.update(m['reader'] for m in measures if m.get('reader'))

    record_cache = {}

    def records_for(reader_name):
        if reader_name in record_cache:
            return record_cache[reader_name]
        records = []
        source = spec.get('sources', {}).get(reader_name)
        if source is not None:
            options = source if isinstance(source, dict) else {}
            source_path = options.get('path') if options else source
            loaded, why = read_source(registry, reader_name, expand(source_path, spec.get('root') or root), {}, options)
            if loaded is None:
                raise ValueError(f'Cannot safely pin {reader_name} memberships: {why}')
            records = loaded
        # Membership pins need the reader's original sequence position. Existing authored overrides replace source rows in the
        # tokenizer; counting them after the source rows (as records_for() does below) shifts every override's order and can
        # move an old piece-level word across adjacent timed words when a new unit is added.
        extras = spec.get('records', {}).get(reader_name, [])
        extra_ids = {record.get('id') for record in extras}
        source_orders = _reader_source_orders(records, extras)
        records = [record for record in records if record.get('id') not in extra_ids]
        reader_orders[reader_name] = source_orders
        records.extend(copy.deepcopy(extras))
        record_cache[reader_name] = records
        return records

    reader_orders = {}

    def reader_order(reader_name, record_id):
        if reader_name not in reader_orders:
            records_for(reader_name)
        if record_id not in reader_orders[reader_name]:
            raise ValueError(f'Cannot preserve source order for {reader_name} record {record_id}')
        return reader_orders[reader_name][record_id]

    pins = {}
    for token_id, token in tokens['tokens'].items():
        if token.get('unit') != 'piece':
            continue
        matches = []
        for dim_id, value in token.get('dims', {}).items():
            dim = dims.get(dim_id, {})
            measure_list = dim.get('measure') or []
            measure_list = [measure_list] if isinstance(measure_list, dict) else measure_list
            for measure in measure_list:
                reader_name, field = measure.get('reader'), measure.get('field')
                if not reader_name or reader_name not in spec.get('sources', {}) and reader_name not in spec.get('records', {}):
                    continue
                for record in records_for(reader_name):
                    if record.get('id') != token.get('record'):
                        continue
                    source_value = (record.get('fields') or {}).get(field)
                    kind = registry.kind_of(dim_id)
                    split_record = (measure.get('token') == 'word' and not record.get('one_word')
                                    and kind and kind.get('split'))
                    ids = ([f"{record['id']}/{field}/{index}" for index, _ in enumerate(split_words(source_value, registry))]
                           if isinstance(source_value, str) and split_record
                           else [record.get('id')])
                    if token_id in ids:
                        matches.append((reader_name, record))
        if not matches:
            raise ValueError(f'Cannot identify the declared reader record for existing implicit token {token_id}')
        for reader_name, record in matches:
            if (reader_name, record['id']) in skip_records:
                continue
            current = record.get('unit')
            if current not in (None, 'piece'):
                raise ValueError(f'Conflicting reader unit for existing token {token_id}: {current!r} vs "piece"')
            key = (reader_name, record['id'])
            prior = pins.get(key)
            if prior and prior.get('unit') != 'piece':
                raise ValueError(f'Conflicting preserved reader units for {reader_name} record {record["id"]}')
            pinned = copy.deepcopy(record)
            pinned['unit'] = 'piece'
            pinned['record_order'] = reader_order(reader_name, record['id'])
            pins[key] = pinned

    by_reader = {}
    for (reader_name, _), record in pins.items():
        by_reader.setdefault(reader_name, []).append(record)
    for reader_name, additions in by_reader.items():
        existing = spec.setdefault('records', {}).setdefault(reader_name, [])
        by_id = {record.get('id'): record for record in existing}
        if len(by_id) != len(existing):
            raise ValueError(f'Cannot safely pin {reader_name}: duplicate authored record identities')
        for record in additions:
            old = by_id.get(record['id'])
            if old:
                if old.get('unit') not in (None, 'piece'):
                    raise ValueError(f'Conflicting authored unit for {reader_name} record {record["id"]}')
                old['unit'] = 'piece'
            else:
                existing.append(record)


def _source_records(spec, reader_name, registry, root):
    wt_core, _ = template_modules()
    source = spec.get('sources', {}).get(reader_name)
    if source is None:
        return {}
    options = source if isinstance(source, dict) else {}
    source_path = options.get('path') if options else source
    loaded, why = wt_core.read_source(registry, reader_name,
                                      wt_core.expand(source_path, spec.get('root') or root), {}, options)
    if loaded is None:
        raise ValueError(f'Cannot validate membership migration for {reader_name}: {why}')
    return {record.get('id'): record for record in loaded}


def _source_record_orders(spec, reader_name, registry, root):
    """Return unmodified reader positions, before authored overrides are applied."""
    wt_core, _ = template_modules()
    source = spec.get('sources', {}).get(reader_name)
    if source is None:
        return {}
    options = source if isinstance(source, dict) else {}
    source_path = options.get('path') if options else source
    loaded, why = wt_core.read_source(registry, reader_name,
                                      wt_core.expand(source_path, spec.get('root') or root), {}, options)
    if loaded is None:
        raise ValueError(f'Cannot validate membership migration order for {reader_name}: {why}')
    return _reader_source_orders(loaded, spec.get('records', {}).get(reader_name, []))


def _pinned_file(root, base, raw, expected, label):
    """A file under the source root whose BLAKE3 identity is the one declared."""
    path = Path(raw)
    path = path if path.is_absolute() else base / path
    path = path.resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError(f'Membership migration {label} is missing or outside the source root: {path}')
    if content_identity(path) != expected:
        raise ValueError(f'Membership migration {label} identity changed: {path}')
    return path


def _validate_membership_migrations(P, data, prior_snapshot, spec, rows, registry, root, leaf):
    """Validate explicit whole-record piece-to-unit migrations against readers and source rows."""
    id_column = P['table']['id_column']
    mode = data.get('membership_migration_mode')
    migration_fields = {'membership_migrations', 'preserved_piece_memberships', 'membership_migration_basis'}
    if mode is None:
        if any(key in data for key in migration_fields):
            raise ValueError('Membership migration fields require explicit membership_migration_mode')
        return {'token_units': {}, 'release_records': set(),
                'readback': {'mode': 'disabled', 'validated_record_count': 0,
                             'validated_token_count': 0, 'assignments': [],
                             'preserved_explicit_piece_count': 0,
                             'preserved_explicit_piece_memberships': [], 'basis': None}}
    if mode != P['membership_mode']:
        raise ValueError(f'Unsupported membership_migration_mode: {mode!r}')
    raw = data.get('membership_migrations') or []
    if not isinstance(raw, list):
        raise ValueError('membership_migrations must be a list')
    basis = data.get('membership_migration_basis')
    if not isinstance(basis, dict):
        raise ValueError('Membership migrations require frozen prior consumer/spec identities')

    prior_spec = None
    prior_consumer = None
    for key, label in (('spec_path', 'prior spec'), ('consumer_path', 'prior consumer')):
        value = basis.get(key)
        expected = basis.get(key.replace('_path', '_identity'))
        if not isinstance(value, str) or not isinstance(expected, dict):
            raise ValueError(f'Membership migration is missing {label} identity')
        path = _pinned_file(root, leaf, value, expected, label)
        if key == 'spec_path':
            prior_spec = read_json(path)
        else:
            prior_consumer = read_json(path)
    baseline_tokens = {token['id']: token for token in prior_consumer.get('tokens', [])}
    if baseline_tokens != prior_snapshot['tokens']:
        raise ValueError('Frozen prior consumer does not match the current pre-adoption source readback')
    if spec.get('records', {}) != prior_spec.get('records', {}):
        raise ValueError('Current replay reader overrides differ from the frozen preflight spec')
    # The live preflight may already contain generated piece pins from an earlier adoption. Keep that exact current spec/consumer
    # as the replay baseline, while using the separately frozen pre-adoption pair to tell authored pins from generated overrides
    # of implicit fallbacks.
    provenance_fields = (
        ('provenance_spec_path', 'provenance_spec_identity', 'original pre-adoption spec'),
        ('provenance_consumer_path', 'provenance_consumer_identity', 'original pre-adoption consumer'),
    )
    provenance = {}
    for path_key, identity_key, label in provenance_fields:
        raw_path = basis.get(path_key)
        identity = basis.get(identity_key)
        if not isinstance(raw_path, str) or not isinstance(identity, dict):
            raise ValueError(f'Membership migration is missing {label} identity')
        path = _pinned_file(root, leaf, raw_path, identity, label, label)
        provenance['spec' if path_key.endswith('spec_path') else 'consumer'] = read_json(path)
    provenance_spec = provenance['spec']
    provenance_consumer = provenance['consumer']
    provenance_tokens = {token['id']: token for token in provenance_consumer.get('tokens', [])}
    evidence_sources = basis.get('evidence_sources')
    if not isinstance(evidence_sources, dict) or not evidence_sources:
        raise ValueError('Membership migrations require identity-checked review evidence sources')
    for value, expected in evidence_sources.items():
        if not isinstance(value, str) or not isinstance(expected, dict):
            raise ValueError('Membership migration evidence source identity is malformed')
        evidence_path = Path(value)
        evidence_path = evidence_path if evidence_path.is_absolute() else leaf / evidence_path
        evidence_path = evidence_path.resolve()
        if not evidence_path.is_relative_to(root.resolve()) or not evidence_path.is_file():
            raise ValueError(f'Membership migration evidence is missing or outside the source root: {evidence_path}')
        if content_identity(evidence_path) != expected:
            raise ValueError(f'Membership migration evidence identity changed: {evidence_path}')

    # Build the eligible set from actual old piece-level tokens, their declared reader records, and full half-open containment
    # in the resulting rows.
    source_cache = {}
    source_order_cache = {}
    overrides = spec.get('records', {})
    eligible = {}
    for token_id, token in prior_snapshot['tokens'].items():
        if token.get('unit') != 'piece' or token.get('t') is None or token.get('t1') is None:
            continue
        original_token = provenance_tokens.get(token_id)
        if original_token is None or original_token.get('unit') != 'piece':
            continue
        if original_token != token:
            raise ValueError(f'Pre-adoption piece token changed in current replay basis: {token_id}')
        start, stop = token['t'], token['t1']
        targets = [row for row in rows
                   if float(row[P['table']['start']]) <= start < float(row[P['table']['end']])
                   and stop <= float(row[P['table']['end']]) + 1e-9]
        if len(targets) != 1:
            continue
        record_id = token.get('record')
        for dimension in token.get('dims', {}):
            dim = registry.dims.get(dimension, {})
            measures = dim.get('measure') or []
            measures = [measures] if isinstance(measures, dict) else measures
            for measure in measures:
                reader = measure.get('reader')
                if not reader or reader not in spec.get('sources', {}):
                    continue
                if reader not in source_cache:
                    source_cache[reader] = _source_records(spec, reader, registry, root)
                    source_order_cache[reader] = _source_record_orders(provenance_spec, reader, registry, root)
                source_record = source_cache[reader].get(record_id)
                if source_record is None:
                    continue
                source_start, source_stop = source_record.get('t0'), source_record.get('t1')
                if (source_start is None or source_stop is None
                        or abs(float(source_start) - float(start)) > 1e-9
                        or abs(float(source_stop) - float(stop)) > 1e-9):
                    continue
                override = next((record for record in overrides.get(reader, [])
                                 if record.get('id') == record_id), None)
                baseline_rows = provenance_spec.get('records', {}).get(reader, [])
                baseline_override = next((record for record in baseline_rows
                                          if record.get('id') == record_id), None)
                origin = ('explicit_prior_piece_pin' if baseline_override and
                          baseline_override.get('unit') == 'piece' else 'implicit_fallback')
                key = (reader, record_id)
                candidate = eligible.setdefault(key, {
                    'reader': reader, 'record_id': record_id, 'from_unit': 'piece',
                    'to_unit': targets[0][id_column], 't0': float(source_start),
                    't1': float(source_stop), 'origin': origin, 'token_ids': [],
                    'prior_override_record_order': (baseline_override or {}).get('record_order'),
                })
                if candidate['to_unit'] != targets[0][id_column] or candidate['origin'] != origin:
                    raise ValueError(f'Conflicting membership migration source: {reader}/{record_id}')
                candidate['token_ids'].append(token_id)

    normalized = {}
    for item in raw:
        if not isinstance(item, dict) or not all(k in item for k in
            ('reader', 'record_id', 'from_unit', 'to_unit', 't0', 't1', 'origin', 'token_ids')):
            raise ValueError('Each membership migration needs reader, record_id, from/to units, times, origin, and token_ids')
        key = (item['reader'], item['record_id'])
        if key in normalized:
            raise ValueError(f'Duplicate membership migration: {key[0]}/{key[1]}')
        normalized[key] = item
    preserved = {}
    preserved_rows = data.get('preserved_piece_memberships', [])
    if not isinstance(preserved_rows, list):
        raise ValueError('preserved_piece_memberships must be a list')
    for item in preserved_rows:
        if not isinstance(item, dict) or not all(k in item for k in
            ('reader', 'record_id', 'from_unit', 't0', 't1', 'token_ids', 'reason', 'evidence_path')):
            raise ValueError('Each preserved piece membership needs reader, record_id, from_unit, times, token_ids, reason and evidence_path')
        key = (item['reader'], item['record_id'])
        if key in preserved:
            raise ValueError(f'Duplicate preserved piece membership: {key[0]}/{key[1]}')
        if item['evidence_path'] not in evidence_sources:
            raise ValueError(f'Preserved piece membership {key[0]}/{key[1]} lacks a declared evidence path')
        preserved[key] = item
    if set(normalized) & set(preserved):
        raise ValueError('A piece membership cannot be both migrated and preserved')
    for key, expected in eligible.items():
        target = normalized.get(key) or preserved.get(key)
        if target is None:
            if expected['origin'] == 'implicit_fallback':
                raise ValueError(f'Eligible implicit piece fallback was omitted: {key[0]}/{key[1]}')
            raise ValueError(f'Eligible explicit piece pin needs a declared migration or preservation: {key[0]}/{key[1]}')
    unknown = sorted(f'{r}/{i}' for r, i in (set(normalized) | set(preserved)) - set(eligible))
    if unknown:
        raise ValueError(f'Membership migration or preservation names unknown/ineligible records: {unknown[:8]}')

    token_units = {}
    release_records = set()
    preserved_readback = []
    for key, expected in eligible.items():
        item = normalized.get(key) or preserved.get(key)
        for field in ('from_unit', 'to_unit', 'origin'):
            if field == 'origin' and key in preserved:
                continue
            if field == 'to_unit' and key in preserved:
                continue
            if item.get(field) != expected[field]:
                raise ValueError(f'Membership migration {key[0]}/{key[1]} has unexpected {field}')
        if (not math.isfinite(float(item['t0'])) or not math.isfinite(float(item['t1']))
                or abs(float(item['t0']) - expected['t0']) > 1e-9
                or abs(float(item['t1']) - expected['t1']) > 1e-9):
            raise ValueError(f'Membership migration {key[0]}/{key[1]} source times changed')
        if item.get('evidence_path') not in basis.get('evidence_sources', {}):
            raise ValueError(f'Membership migration {key[0]}/{key[1]} lacks a declared evidence path')
        if sorted(set(item['token_ids'])) != sorted(set(expected['token_ids'])):
            raise ValueError(f'Membership migration {key[0]}/{key[1]} token IDs changed')
        if key not in preserved and item.get('prior_override_record_order') != expected['prior_override_record_order']:
            raise ValueError(f'Membership migration {key[0]}/{key[1]} record_order changed')
        source = source_cache[key[0]][key[1]]
        source_order = source_order_cache[key[0]].get(key[1])
        if source_order is None:
            raise ValueError(f'Membership migration source order is unknown: {key[0]}/{key[1]}')
        baseline_rows = provenance_spec.get('records', {}).get(key[0], [])
        baseline_override = next((record for record in baseline_rows
                                  if record.get('id') == key[1]), None)
        if key in preserved:
            if expected['origin'] != 'explicit_prior_piece_pin':
                raise ValueError(f'Only explicit prior piece pins may be preserved: {key[0]}/{key[1]}')
            if not baseline_override or baseline_override.get('unit') != 'piece':
                raise ValueError(f'Preserved piece membership lacks a frozen prior pin: {key[0]}/{key[1]}')
            clean_source = {k: v for k, v in source.items() if k not in ('unit', 'record_order')}
            clean_override = {k: v for k, v in baseline_override.items() if k not in ('unit', 'record_order')}
            if clean_override != clean_source:
                raise ValueError(f'Preserved explicit piece payload differs from reader source: {key[0]}/{key[1]}')
            current = next((record for record in overrides.get(key[0], [])
                            if record.get('id') == key[1]), None)
            if not current or current.get('unit') != 'piece':
                raise ValueError(f'Preserved piece membership conflicts with live override: {key[0]}/{key[1]}')
            current_clean = {k: v for k, v in current.items() if k not in ('unit', 'record_order')}
            if current_clean != clean_source:
                raise ValueError(f'Preserved live piece payload differs from reader source: {key[0]}/{key[1]}')
            if current.get('record_order') != baseline_override.get('record_order'):
                raise ValueError(f'Preserved piece membership changed live record order: {key[0]}/{key[1]}')
            preserved_readback.append(item)
            continue
        if expected['origin'] == 'implicit_fallback':
            if baseline_override and baseline_override.get('unit') is not None:
                raise ValueError(f'Implicit migration conflicts with authored unit: {key[0]}/{key[1]}')
            # A first adoption has no generated override yet; a replay from an earlier adoption does. In both cases validate the
            # raw source position. If a generated override exists, it must still be the exact source record at that position
            # before its piece pin is released.
            current = next((record for record in overrides.get(key[0], [])
                            if record.get('id') == key[1]), None)
            clean_source = {k: v for k, v in source.items() if k not in ('unit', 'record_order')}
            if current is not None:
                if current.get('unit') != 'piece':
                    raise ValueError(f'Implicit migration conflicts with live override unit: {key[0]}/{key[1]}')
                clean_override = {k: v for k, v in current.items() if k not in ('unit', 'record_order')}
                if clean_override != clean_source:
                    raise ValueError(f'Implicit piece payload differs from reader source: {key[0]}/{key[1]}')
                if current.get('record_order') != source_order:
                    raise ValueError(f'Implicit piece record_order differs from reader source: {key[0]}/{key[1]}')
        else:
            if not baseline_override or baseline_override.get('unit') != 'piece':
                raise ValueError(f'Explicit piece-pin correction lacks frozen prior pin: {key[0]}/{key[1]}')
            clean_source = {k: v for k, v in source.items() if k not in ('unit', 'record_order')}
            clean_override = {k: v for k, v in baseline_override.items() if k not in ('unit', 'record_order')}
            if clean_override != clean_source:
                raise ValueError(f'Explicit piece-pin payload differs from reader source: {key[0]}/{key[1]}')
            current = next((record for record in overrides.get(key[0], [])
                            if record.get('id') == key[1]), None)
            if not current or current.get('unit') != 'piece':
                raise ValueError(f'Explicit piece-pin correction conflicts with live override: {key[0]}/{key[1]}')
            current_clean = {k: v for k, v in current.items() if k not in ('unit', 'record_order')}
            if current_clean != clean_source:
                raise ValueError(f'Explicit live piece payload differs from reader source: {key[0]}/{key[1]}')
            if current.get('record_order') != baseline_override.get('record_order'):
                raise ValueError(f'Explicit piece-pin correction changed live record order: {key[0]}/{key[1]}')
        current = next((record for record in overrides.get(key[0], [])
                        if record.get('id') == key[1]), None)
        if current is not None and current.get('unit') == 'piece':
            # Retain all reader-order evidence while removing the obsolete piece membership. Implicit first-pass fallbacks
            # may have no row.
            current.pop('unit')
        for token_id in expected['token_ids']:
            token_units[token_id] = expected['to_unit']
        release_records.add(key)

    return {
        'token_units': token_units,
        'release_records': release_records,
        'readback': {'validated_record_count': len(eligible),
                     'mode': mode,
                     'validated_token_count': len(token_units),
                     'by_origin': {origin: sum(1 for item in eligible.values() if item['origin'] == origin)
                                   for origin in sorted({item['origin'] for item in eligible.values()})},
                     'assignments': [normalized[key] for key in sorted(normalized)],
                     'preserved_explicit_piece_count': len(preserved_readback),
                     'preserved_explicit_piece_memberships': preserved_readback,
                     'basis': basis},
    }


def prepare(P, data, prior_rows, fields, prior_spec, vocabulary, count_words, leaf, root):
    """Validate the complete prospective result before writing any owner."""
    wt_core, _ = template_modules()
    table, scene, word = P['table'], P['scene_slot'], P['word']
    start_col, end_col, id_column_default = table['start'], table['end'], table['id_column']
    unknown = table['unknown']
    ratio = data['seconds_per_frame']
    if len(ratio) != 2 or min(ratio) <= 0:
        raise ValueError('An explicit positive native frame clock is required')
    seconds = lambda n: n * ratio[0] / ratio[1]
    rows, spec = copy.deepcopy(prior_rows), copy.deepcopy(prior_spec)
    registry = wt_core.Registry.load(spec.get('registry') or str(root / P['registry']))
    fields = list(fields) + [k for k in (table['evidence'], table['scope']) if k not in fields]
    # The template's legacy reader used row order as record identity. Preserve those identities before inserting earlier
    # evidence into the chronology.
    source_options = spec.setdefault('sources', {}).get(table['reader'], {})
    if isinstance(source_options, dict):
        source_options = copy.deepcopy(source_options)
    elif source_options:
        source_options = {'path': source_options}
    else:
        source_options = {'path': table['file']}
    id_column = source_options.get('id_column') if isinstance(source_options, dict) else None
    if not id_column:
        id_column = id_column_default
        if id_column in fields:
            raise ValueError('Undeclared record identity column already exists')
        fields.append(id_column)
        for i, row in enumerate(rows, 1):
            row[id_column] = f'{table["id_prefix"]}{i:0{table["id_width"]}d}'
    elif id_column not in fields:
        raise ValueError('Declared record identity column is missing')
    identities = {row.get(id_column) for row in rows}
    if len(identities) != len(rows) or any(not isinstance(v, str) or not v.strip() for v in identities):
        raise ValueError('Existing picture identities must be nonempty and unique')
    if isinstance(source_options, dict) and not source_options.get('id_column'):
        source_options['id_column'] = id_column
    spec['sources'][table['reader']] = source_options
    # Run the actual source readers on the pre-write rows before adding any intervals. The tokenizer is the authority for
    # implicit time membership.
    prior_snapshot = _token_snapshot(P, spec, rows, fields, registry, root)
    prior_tokens = prior_snapshot['tokens']
    prior_slots = copy.deepcopy(prior_spec.get('slots', []))
    prior_line_ids = {
        line['id']: (line.get('dim'), line.get('job'), list(line.get('tokens', [])))
        for line in prior_snapshot['lines']
        if any(token_id in line.get('tokens', []) for token_id in prior_tokens)
    }
    # Auto-generated line ordinals can shift when earlier rows are inserted. Materialize the old reader-produced lines as
    # ordinary template lines so their IDs and jobs stay stable; new words can then append after them.
    line_definitions = spec.setdefault('lines', {})
    auto_lines_by_dim = {}
    for line in prior_snapshot['lines']:
        if line['dim'] not in line_definitions:
            auto_lines_by_dim.setdefault(line['dim'], []).append(line)
    for dimension, definitions in auto_lines_by_dim.items():
        line_definitions[dimension] = [
            {'id': line['id'], 'from': line['tokens'][0], 'to': line['tokens'][-1],
             'job': line.get('job')}
            for line in definitions if line.get('tokens')
        ]
    next_identity = len(rows) + 1
    existing_rows = {(round(float(r[start_col]), 7), round(float(r[end_col]), 7)): r for r in rows}
    keys = set(existing_rows)
    added, new_picture_ids = [], []
    detail_name = P['files']['detail']
    leaf_depth = len(Path(data['leaf']).parts)
    for item in data['intervals']:
        a, z = item['first'], item['first_absent']
        if not isinstance(a, int) or not isinstance(z, int) or a < 0 or a >= z:
            raise ValueError('Intervals require ordered zero-based native frame indices')
        key = (round(seconds(a), 7), round(seconds(z), 7))
        if key in keys:
            existing = existing_rows[key]
            if any(str(existing[k]) != str(v) for k, v in item.items() if k in fields):
                raise ValueError('An existing interval has different reviewed content')
            continue
        row = {field: unknown for field in fields}
        row.update({k: v for k, v in item.items() if k in fields})
        while f'{table["id_prefix"]}{next_identity:0{table["id_width"]}d}' in identities:
            next_identity += 1
        row[id_column] = f'{table["id_prefix"]}{next_identity:0{table["id_width"]}d}'
        identities.add(row[id_column])
        next_identity += 1
        row.update({start_col: f'{seconds(a):.9f}', end_col: f'{seconds(z):.9f}',
                    table['transition']: item.get(table['transition'], unknown),
                    table['evidence']: str((leaf / detail_name).relative_to(leaf.parents[leaf_depth - 1])),
                    table['scope']: item['qualification'] + ' ' + data['scope']})
        if table['duration'] in fields:
            row[table['duration']] = f'{seconds(z) - seconds(a):.9f}'
        rows.append(row)
        existing_rows[key] = row
        keys.add(key)
        added.append([a, z])
        new_picture_ids.append(row[id_column])
    rows.sort(key=lambda row: float(row[start_col]))
    end = -math.inf
    for row in rows:
        start, stop = float(row[start_col]), float(row[end_col])
        if not math.isfinite(start) or not math.isfinite(stop) or start < end - 1e-7 or start >= stop:
            raise ValueError('Prospective shot rows overlap or have invalid times')
        end = stop
    _validate_vocabulary(rows, vocabulary)
    spec.setdefault('sources', {})[table['reader']] = {
        'path': str(leaf.parents[leaf_depth - 1] / table['file']),
        'missing_values': [unknown],
        'id_column': id_column,
    }
    migrations = _validate_membership_migrations(P, data, prior_snapshot, spec, rows, registry, root, leaf)
    _pin_implicit_memberships(spec, prior_snapshot, registry, root, skip_records=migrations['release_records'])
    existing_slots = {s['id']: copy.deepcopy(s) for s in spec.get('slots', [])}
    existing_scene_slots = _existing_scene_slots(P, list(existing_slots.values()))
    prefix = scene['id_prefix']
    next_slot = max((int(k.removeprefix(prefix)) for k in existing_slots if k.startswith(prefix)), default=-1) + 1
    # Keep existing slot objects and order; sorting pictures must not rewrite slot ownership, and an unchanged replay must
    # produce the same spec.
    spec.setdefault('slots', [])
    for row in rows:
        token_ids = [row[id_column]]
        old = existing_scene_slots.get(tuple(token_ids))
        if old:
            continue
        slot_id = f'{prefix}{next_slot}'
        next_slot += 1
        spec['slots'].append({'id': slot_id, 'type': scene['type'], 'rule': scene['rule'], 'tokens': token_ids,
                              'dims': list(scene['dims']), 'note': scene['note']})
    for record_id in new_picture_ids:
        for dimension in scene['dims']:
            append_pinned_line(spec, dimension, [record_id])
    prospective_snapshot = _token_snapshot(P, spec, rows, fields, registry, root)
    prospective_tokens = prospective_snapshot['tokens']
    for token_id, old_token in prior_tokens.items():
        if token_id not in prospective_tokens:
            raise ValueError(f'Prospective tokenizer dropped existing token: {token_id}')
        new_token = prospective_tokens[token_id]
        if new_token != old_token:
            allowed_unit = migrations['token_units'].get(token_id)
            changed = [key for key in set(old_token) | set(new_token)
                       if key != 'unit' and old_token.get(key) != new_token.get(key)]
            if allowed_unit is None or changed or new_token.get('unit') != allowed_unit:
                changed_fields = changed + (['unit'] if new_token.get('unit') != old_token.get('unit') else [])
                raise ValueError(f'Adding picture intervals would change existing token payload: {token_id} '
                                 f'({", ".join(sorted(set(changed_fields)))})')
    if spec.get('slots', [])[:len(prior_slots)] != prior_slots:
        raise ValueError('Prospective template changed existing slot definitions')
    prospective_line_ids = {
        line['id']: (line.get('dim'), line.get('job'), list(line.get('tokens', [])))
        for line in prospective_snapshot['lines']
    }
    for line_id, prior_job in prior_line_ids.items():
        if prospective_line_ids.get(line_id) != prior_job:
            raise ValueError(f'Prospective template changed existing line identity or job: {line_id}')
    records = spec.setdefault('records', {}).setdefault(word['reader'], [])
    for entry in data.get('words', []):
        existing = next((r for r in records if r['id'] == entry['id']), None)
        if existing:
            if existing['fields']['text'] != entry['text'] or abs(existing['t0'] - seconds(entry['native'])) > 1e-8:
                raise ValueError(f'Existing word record conflicts: {entry["id"]}')
            continue
        frame = (leaf / entry['path']).resolve()
        if not frame.is_file():
            raise ValueError(f'Missing readable picture: {frame}')
        records.append({'id': entry['id'], 't0': seconds(entry['native']), 't1': seconds(entry['native'] + 1),
                        'fields': {'text': entry['text']}, 'evidence': {
                            'method': entry.get('evidence_method', word['method']),
                            'frame': str(frame), 'reading_journal': str(leaf / P['files']['journal']),
                            'time_semantics': word['time_semantics'],
                            'interpretation': entry['qualification']}})
        token_ids = [f'{entry["id"]}/text/{i}' for i in range(count_words(entry['text']))]
        spec['slots'].append({'id': entry['id'], 'type': word['slot_type'], 'rule': word['rule'],
                              'tokens': token_ids, 'note': word['slot_note']})
        append_pinned_line(spec, word['line_dim'], token_ids)
    spec['piece'][table['coverage_key']] = table['coverage_text'].format(rows=len(rows), coverage=data['coverage'])
    return rows, fields, spec, added, migrations['readback']


def _append_unique(values, additions):
    result = list(values)
    seen = set(result)
    for value in additions:
        if value not in seen:
            result.append(value)
            seen.add(value)
    return result


def _validate_source_review(P, data, journal_path, root):
    """Keep finalized-page checks; also admit pinned, saved original-frame notes.

    File/clock joins cannot certify that a note was actually observed, or recover an unavailable extraction invocation. Those
    qualifications stay explicit.
    """
    kinds = P['review_kinds']
    retained = data.get('retained_original_review')
    if retained is None:
        frame_evidence.validate_page_journal(journal_path, P['frame_evidence'])
        journal = read_json(journal_path)
        refs = [journal['source_manifest']['path'], journal['extraction_readback']['path']]
        for page in journal['pages']:
            refs.extend([page['observation']['path'], page['readback']['path'], page['contact_sheet']['path']])
        return {'kind': kinds['finalized'], 'refs': [Path(p).resolve() for p in refs]}
    if not isinstance(retained, dict):
        raise ValueError('retained_original_review must be a pinned review description')

    def pinned(ref, label):
        if not isinstance(ref, dict) or not isinstance(ref.get('path'), str):
            raise ValueError(f'{label} needs path and BLAKE3 identity')
        candidate = Path(ref['path'])
        candidate = (root / candidate).resolve(strict=True) if not candidate.is_absolute() else candidate.resolve(strict=True)
        expected = ref.get('identity')
        if not candidate.is_relative_to(root) or not candidate.is_file():
            raise ValueError(f'{label} must be a file under the declared source root')
        if not isinstance(expected, dict) or expected.get('algorithm') != 'blake3' or content_identity(candidate) != expected:
            raise ValueError(f'{label} BLAKE3 identity does not match')
        return candidate
    saved = pinned(retained.get('journal'), 'Saved review journal')
    if saved != journal_path.resolve():
        raise ValueError('Saved review journal differs from journal_path')
    journal_text = saved.read_text(encoding='utf-8')
    manifest_path = pinned(retained.get('manifest'), 'Retained source manifest')
    source_path = pinned(retained.get('source'), 'Retained original source')
    manifest = read_json(manifest_path)
    if not isinstance(manifest, dict) or not isinstance(manifest.get('source'), dict):
        raise ValueError('Retained manifest must contain an original source object')
    if frame_evidence.resolve_record_path(manifest.get('source', {}).get('path'), manifest_path, 'source.path') != source_path:
        raise ValueError('Retained manifest names a different original source')
    time_base, first_pts, origin = frame_evidence.source_clock(manifest)
    source_rows = manifest.get('frames')
    if not isinstance(source_rows, list) or any(not isinstance(r, dict) or type(r.get('index')) is not int for r in source_rows):
        raise ValueError('Retained manifest needs indexed original frame rows')
    by_index = {r['index']: r for r in source_rows}
    if len(by_index) != len(source_rows):
        raise ValueError('Retained manifest frame indices are ambiguous')
    frames = retained.get('reviewed_frames')
    if not isinstance(frames, list) or not frames:
        raise ValueError('Saved review must name the original frames actually reviewed')
    refs, seen = [saved, manifest_path, source_path], set()
    for frame in frames:
        if not isinstance(frame, dict) or type(frame.get('index')) is not int or frame['index'] in seen:
            raise ValueError('Reviewed original frame indices must be unique integers')
        index = frame['index']
        seen.add(index)
        actual = by_index.get(index)
        if (actual is None or type(frame.get('pts')) is not int
                or type(actual.get('pts')) is not int or frame['pts'] != actual['pts']):
            raise ValueError('Reviewed frame index/PTS does not match the retained manifest')
        seconds = frame.get('seconds')
        expected_seconds = float((frame['pts'] - first_pts) * time_base) + origin
        manifest_seconds = actual.get('seconds')
        if (type(seconds) not in (int, float) or not math.isfinite(seconds)
                or type(manifest_seconds) not in (int, float) or not math.isfinite(manifest_seconds)
                or not math.isclose(seconds, expected_seconds, abs_tol=1e-6, rel_tol=0)
                or not math.isclose(seconds, manifest_seconds, abs_tol=1e-6, rel_tol=0)):
            raise ValueError('Reviewed frame clock does not match the source PTS')
        path = pinned(frame, f'Reviewed frame {index}')
        if path != frame_evidence.resolve_record_path(actual.get('path'), manifest_path, f'frame {index}'):
            raise ValueError('Reviewed frame path differs from the retained original')
        quote = frame.get('journal_quote')
        index_pattern = rf'(?<!\w)(?:[fF])?{index}(?!\w)'
        if not isinstance(quote, str) or not quote.strip() or quote not in journal_text or not re.search(index_pattern, quote):
            raise ValueError('Reviewed frame needs its exact saved journal quote naming the index')
        identity_quote = frame.get('journal_identity_quote')
        if identity_quote is not None:
            if (not isinstance(identity_quote, str) or not identity_quote.strip()
                    or identity_quote not in journal_text or not re.search(index_pattern, identity_quote)
                    or frame['identity']['value'] not in identity_quote):
                raise ValueError('Reviewed frame needs an exact saved index/identity excerpt')
        elif not any(re.search(index_pattern, line) and frame['identity']['value'] in line
                     for line in journal_text.splitlines()):
            raise ValueError('Saved review journal needs an index/identity line or exact journal_identity_quote excerpt')
        refs.append(path)
    extraction = retained.get('extraction_provenance')
    if not isinstance(extraction, dict) or extraction.get('status') not in ('unknown', 'recorded'):
        raise ValueError('Extraction provenance must stay explicitly unknown or point to a retained record')
    if extraction['status'] == 'unknown':
        if not isinstance(extraction.get('reason'), str) or not extraction['reason'].strip() or 'record' in extraction:
            raise ValueError('Unknown extraction provenance needs its reason without a fabricated record')
    else:
        refs.append(pinned(extraction.get('record'), 'Retained extraction record'))
    return {'kind': kinds['retained'], 'refs': refs, 'extraction_provenance': copy.deepcopy(extraction),
            'qualification': P['retained_qualification']}


def adopt_source_evidence_only(store: Store, P: dict, input_path, root):
    """Attach bounded source review evidence without changing the timeline table.

    The declared before-spec BLAKE3 is mandatory. The review packet and all its declared source joins are validated before any
    file changes. Only the spec's evidence member is changed; the piece's answer to the profile's question is refreshed with its
    status, label and flags unchanged.
    """
    P = check_profile(P)
    S = P['source_evidence_only']
    table_file = P['table']['file']
    input_path = Path(input_path).expanduser().resolve(strict=True)
    root = Path(root).resolve(strict=True)
    data = read_json(input_path)
    if data.get('schema') != S['schema']:
        raise ValueError('Unsupported source-evidence-only adoption schema')
    piece_raw, leaf_raw = data.get('piece'), data.get('leaf')
    if not isinstance(piece_raw, str) or not isinstance(leaf_raw, str):
        raise ValueError('Source-evidence-only adoption requires piece and leaf paths')
    piece = (root / piece_raw).resolve() if not Path(piece_raw).is_absolute() else Path(piece_raw).resolve()
    leaf_candidate = Path(leaf_raw)
    leaf = (piece / leaf_candidate).resolve() if not leaf_candidate.is_absolute() else leaf_candidate.resolve()
    spec_raw = data.get('spec_path', P['spec_file'])
    spec_part = Path(spec_raw)
    spec_path = (piece / spec_part).resolve() if not spec_part.is_absolute() else spec_part.resolve()
    if not piece.is_relative_to(root) or not leaf.is_relative_to(piece) or not spec_path.is_relative_to(piece):
        raise ValueError('Piece, evidence leaf and spec must remain under the declared source root/piece')
    if not leaf.is_dir() or not spec_path.is_file():
        raise ValueError('Source-evidence leaf and template spec must already exist')
    before_identity = data.get('before_spec_identity')
    if not isinstance(before_identity, dict) or before_identity.get('algorithm') != 'blake3':
        raise ValueError('A current before-spec BLAKE3 identity is required')
    if content_identity(spec_path) != before_identity:
        raise ValueError('Current template spec does not match the declared before-spec identity')

    journal_raw = data.get('journal_path')
    if not isinstance(journal_raw, str) or not journal_raw.strip():
        raise ValueError('A source review journal path is required')
    journal_path = Path(journal_raw)
    journal_path = (root / journal_path).resolve() if not journal_path.is_absolute() else journal_path.resolve()
    if not journal_path.is_relative_to(root):
        raise ValueError('Source review journal must remain under the declared source root')
    review = _validate_source_review(P, data, journal_path, root)

    raw_paths = data.get('evidence_paths')
    if not isinstance(raw_paths, list) or not raw_paths or any(not isinstance(raw, str) or not raw.strip() for raw in raw_paths):
        raise ValueError('A nonempty bounded evidence_paths list is required')
    evidence_paths, seen_paths = [], set()
    for raw in raw_paths:
        candidate = Path(raw)
        path = (root / candidate).resolve(strict=True) if not candidate.is_absolute() else candidate.resolve(strict=True)
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError(f'Missing or out-of-root source evidence file: {path}')
        if path in seen_paths:
            raise ValueError(f'Duplicate source evidence path: {path}')
        seen_paths.add(path)
        evidence_paths.append(path)
    if journal_path not in seen_paths:
        raise ValueError('The source review journal must be one of the adopted evidence paths')
    missing_refs = [str(path) for path in review['refs'] if path not in seen_paths]
    if missing_refs:
        raise ValueError(f'Evidence paths omit source review inputs: {missing_refs[:3]}')
    scope, evidence_note = data.get('appended_scope'), data.get('evidence_note')
    if not isinstance(scope, str) or not scope.strip() or not isinstance(evidence_note, str) or not evidence_note.strip():
        raise ValueError('A qualified appended_scope and evidence_note are required')
    qid = data.get('question_id')
    if not isinstance(qid, str) or not qid.strip():
        raise ValueError('A selected question_id is required for the evidence refresh')

    preimage_path = leaf / S['before_spec']
    investigation_preimage_path = leaf / S['before_investigation']
    receipt_path = leaf / S['receipt']
    pending_spec = spec_path.with_name(spec_path.name + S['pending_suffix'])
    if (preimage_path.exists() or investigation_preimage_path.exists() or
            receipt_path.exists() or pending_spec.exists()):
        raise ValueError('Source-evidence-only adoption output already exists; refusing overwrite')
    shots_path = piece / table_file
    shots_before = content_identity(shots_path) if shots_path.is_file() else None
    original_spec_bytes = spec_path.read_bytes()
    original_spec = read_json(spec_path)
    updated_spec = copy.deepcopy(original_spec)
    piece_spec = updated_spec.get('piece')
    if not isinstance(piece_spec, dict):
        raise ValueError('Template spec must contain a piece object')
    evidence_key = P['evidence_key']
    motion = piece_spec.get(evidence_key)
    if not isinstance(motion, dict):
        raise ValueError(f'Template spec must declare piece.{evidence_key} as an object')
    next_motion = copy.deepcopy(motion)
    prior_scope = next_motion.get('scope', '')
    if not isinstance(prior_scope, str):
        raise ValueError(f'Existing {evidence_key}.scope must be text')
    next_motion['scope'] = (prior_scope.rstrip() + '\n\n' + scope.strip()).strip()
    prior_additional = next_motion.get('additional_paths', [])
    if not isinstance(prior_additional, list) or any(not isinstance(path, str) for path in prior_additional):
        raise ValueError(f'Existing {evidence_key}.additional_paths must be a string list')
    absolute_evidence_paths = [str(path) for path in evidence_paths]
    next_motion['additional_paths'] = _append_unique(prior_additional, absolute_evidence_paths)
    fields = P['evidence_fields']
    journal_field = fields['journal_paths'] if review['kind'] == P['review_kinds']['finalized'] else fields['retained_paths']
    prior_journals = next_motion.get(journal_field, [])
    if not isinstance(prior_journals, list) or any(not isinstance(path, str) for path in prior_journals):
        raise ValueError(f'Existing {journal_field} must be a string list')
    next_motion[journal_field] = _append_unique(prior_journals, [str(journal_path)])
    if review['kind'] == P['review_kinds']['retained']:
        prior_reviews = next_motion.get(fields['retained_reviews'], [])
        if not isinstance(prior_reviews, list):
            raise ValueError(f'Existing {fields["retained_reviews"]} must be a list')
        next_motion[fields['retained_reviews']] = [*prior_reviews, {
            'journal_path': str(journal_path),
            'review': copy.deepcopy(data['retained_original_review']),
            'qualification': review['qualification'],
        }]
    piece_spec[evidence_key] = next_motion
    siblings_before = {key: value for key, value in original_spec.items() if key != 'piece'}
    siblings_after = {key: value for key, value in updated_spec.items() if key != 'piece'}
    piece_siblings_before = {key: value for key, value in original_spec['piece'].items() if key != evidence_key}
    piece_siblings_after = {key: value for key, value in updated_spec['piece'].items() if key != evidence_key}
    if siblings_before != siblings_after or piece_siblings_before != piece_siblings_after:
        raise ValueError(f'Prospective evidence-only edit changes fields outside {evidence_key}')

    evidence_identities = [content_identity(path) for path in evidence_paths]
    with store.lock():
        if _validate_source_review(P, data, journal_path, root) != review:
            raise ValueError('Source review changed during adoption preflight')
        current_paths_identity = [content_identity(path) for path in evidence_paths]
        if current_paths_identity != evidence_identities:
            raise ValueError('A source evidence file changed during adoption preflight')
        record_path, inv = investigation.load_inv(piece)
        investigation_preimage_bytes = record_path.read_bytes()
        investigation_before = content_identity(record_path)
        if (record_path.read_bytes() != investigation_preimage_bytes or
                read_json(record_path) != inv):
            raise ValueError('Investigation changed while capturing its source-evidence preimage')
        if content_identity(record_path) != investigation_before:
            raise ValueError('Investigation identity changed while capturing its source-evidence preimage')
        node = investigation.node_of(inv, qid)
        current_status = node.get('status')
        current_label = node.get('label', store.investigation['claim_labels'][0])
        current_defect = node.get('defect', False)
        current_caught_by = list(node.get('caught_by') or [])
        if current_status == 'open':
            raise ValueError(f'{qid} has no current non-open status to refresh')
        known_statuses = [status for status in store.investigation['statuses'] if status != 'open']
        if current_status not in known_statuses or current_label not in store.investigation['claim_labels']:
            raise ValueError(f'{qid} current status/label is not valid in the investigation settings')
        if not evidence_note.strip():
            raise ValueError('Evidence refresh note must be nonempty')
        current_evidence = copy.deepcopy(inv['evidence'])
        current_node_evidence = list(node.get('evidence', []))
        old_question_state = {key: copy.deepcopy(node.get(key)) for key in ('status', 'label', 'defect', 'caught_by')}
        answered_at_before = {'present': 'answered_at' in node}
        if answered_at_before['present']:
            answered_at_before['value'] = copy.deepcopy(node['answered_at'])
        if shots_path.is_file() and content_identity(shots_path) != shots_before:
            raise ValueError(f'{table_file} changed during evidence-only preflight')
        if content_identity(spec_path) != before_identity:
            raise ValueError('Template spec changed during source-evidence-only preflight')

        updates = {key: value for key, value in next_motion.items() if motion.get(key) != value or key not in motion}
        serialized = patch_object_members(original_spec_bytes, ('piece', evidence_key), updates)
        if json.loads(serialized) != updated_spec:
            raise ValueError('Narrow source edit differs from prospective evidence-only spec')
        with preimage_path.open('xb') as stream:
            stream.write(original_spec_bytes)
        with investigation_preimage_path.open('xb') as stream:
            stream.write(investigation_preimage_bytes)
        try:
            pending_spec.write_bytes(serialized)
            os.replace(pending_spec, spec_path)
            investigation.record_evidence(store, piece, qid, current_status, [str(path) for path in evidence_paths],
                                          evidence_note.strip(), current_label, current_defect, current_caught_by,
                                          append=True, preserve_answered_at=True)
            _, after_inv = investigation.load_inv(piece)
            after_node = investigation.node_of(after_inv, qid)
            after_evidence_by_id = {row['id']: row for row in after_inv['evidence']}
            if any(after_evidence_by_id.get(row['id']) != row for row in current_evidence):
                raise ValueError('Source-evidence refresh changed an existing evidence object')
            if not set(current_node_evidence).issubset(set(after_node.get('evidence', []))):
                raise ValueError('Source-evidence refresh dropped a current question evidence reference')
            if any(after_node.get(key) != value for key, value in old_question_state.items()):
                raise ValueError('Source-evidence refresh changed current question status/label/flags')
            answered_at_after = {'present': 'answered_at' in after_node}
            if answered_at_after['present']:
                answered_at_after['value'] = copy.deepcopy(after_node['answered_at'])
            if answered_at_after != answered_at_before:
                raise ValueError('Source-evidence refresh changed current question answered_at presence or value')
            if read_json(spec_path) != updated_spec:
                raise ValueError('Current source spec does not read back as the prospective evidence-only edit')
            if content_identity(investigation_preimage_path) != investigation_before:
                raise ValueError('Saved investigation preimage does not match its pinned immediate before identity')
            investigation_after = content_identity(record_path)
            shots_after = content_identity(shots_path) if shots_path.is_file() else None
            if shots_after != shots_before:
                raise ValueError(f'Evidence-only adoption changed {table_file}')
            receipt = {
                'schema': S['readback_schema'],
                'piece': inv['piece'], 'question_id': qid,
                'question_state': {key: after_node.get(key) for key in ('status', 'label', 'defect', 'caught_by')},
                'question_lifecycle': {
                    'before': {**old_question_state, 'answered_at': answered_at_before},
                    'after': {**{key: after_node.get(key) for key in ('status', 'label', 'defect', 'caught_by')},
                              'answered_at': answered_at_after},
                    'preserved': True,
                },
                'journal': {'path': str(journal_path), 'identity': content_identity(journal_path)},
                'before_spec': {'path': str(spec_path), 'identity': before_identity,
                                'preimage_path': str(preimage_path), 'preimage_identity': content_identity(preimage_path)},
                'after_spec': {'path': str(spec_path), 'identity': content_identity(spec_path)},
                'before_investigation': {'path': str(record_path), 'identity': investigation_before,
                                         'preimage_path': str(investigation_preimage_path),
                                         'preimage_identity': content_identity(investigation_preimage_path)},
                'after_investigation': {'path': str(record_path), 'identity': investigation_after},
                'shots_tsv_before': shots_before, 'shots_tsv_after': shots_after,
                'adopted_evidence': [{'path': str(path), 'identity': content_identity(path)} for path in evidence_paths],
                'additional_path_count': len(absolute_evidence_paths),
                'scope_appended': scope.strip(),
                'source_review_kind': review['kind'],
                'source_review_qualification': review.get('qualification', P['finalized_qualification']),
                'extraction_provenance': review.get('extraction_provenance', {'status': 'recorded-in-finalized-journal'}),
                'source_format_preserved': True,
                'exact_byte_inverse_verified': True,
                'preservation': S['preservation'],
            }
            with receipt_path.open('x', encoding='utf-8') as stream:
                json.dump(receipt, stream, ensure_ascii=False, indent=2)
                stream.write('\n')
            return {**receipt, 'receipt_path': str(receipt_path), 'receipt_identity': content_identity(receipt_path)}
        except Exception:
            if pending_spec.exists():
                pending_spec.unlink()
            # Keep the exact preimage if a write crossed the mutation boundary; it is needed for an audited recovery rather
            # than silently discarded.
            raise


def adopt_intervals(store: Store, P: dict, input_path, root):
    P = check_profile(P)
    wt_core, _ = template_modules()
    files, table = P['files'], P['table']
    root = Path(root).resolve(strict=True)
    data = read_json(input_path)
    piece = (root / data['piece']).resolve()
    leaf = (piece / data['leaf']).resolve()
    spec_path = (piece / data.get('spec_path', P['spec_file'])).resolve()
    if not leaf.is_relative_to(piece) or not spec_path.is_relative_to(piece):
        raise ValueError('Evidence and spec must belong to the assigned piece')
    journal_path = leaf / files['journal']
    detail_path = leaf / files['detail']
    detail_note_path = leaf / files['detail_note']
    _preflight_recordable_paths([journal_path, detail_path, detail_note_path])
    journal = read_json(journal_path)
    if not journal.get('pages'):
        raise ValueError('A saved nonempty review journal is required')
    if spec_path.is_file():
        _validate_page_journals(P, read_json(spec_path), piece, journal_path, root)
    detail = read_json(detail_path)
    if not isinstance(detail, dict):
        raise ValueError('A saved detail review object is required')
    approved = leaf / files['input_copy']
    if approved.exists() and read_json(approved) != data:
        raise ValueError('Refusing to replace an earlier adoption with different input')
    registry = wt_core.Registry.load(str(root / P['registry']))
    with store.lock():
        shot_path = piece / table['file']
        if shot_path.exists():
            with shot_path.open(newline='') as stream:
                reader = csv.DictReader(stream, delimiter='\t')
                prior_rows, fields = list(reader), reader.fieldnames
        else:
            # Some registered references have words/sound but no picture table yet. Require the saved review input to declare
            # that first table's columns.
            prior_rows, fields = [], data.get('initial_shot_fields')
            if (not isinstance(fields, list) or not {table['start'], table['end']}.issubset(fields)
                    or len(fields) != len(set(fields))):
                raise ValueError(f'A first picture table requires explicit unique initial_shot_fields including {table["start"]}/{table["end"]}')
        if not fields:
            raise ValueError(f'Existing {table["file"]} header is required')
        prior_spec = read_json(spec_path)
        _validate_declared_frame_links(P, prior_spec, piece, root)
        _validate_page_journals(P, prior_spec, piece, journal_path, root)
        vocabulary = read_json((root / P['vocabulary']).resolve())['fields']
        rows, fields, spec, added, membership_readback = prepare(
            P, data, prior_rows, fields, prior_spec, vocabulary,
            lambda s: len(wt_core.split_words(s, registry)), leaf, root)
        receipt = leaf / files['readback']
        if approved.exists() and not added and receipt.exists():
            return read_json(receipt)
        migration_receipt = leaf / files['membership_readback']
        recordable_paths = [str(approved), str(journal_path), str(detail_path),
                            str(detail_note_path), str(migration_receipt),
                            str(shot_path), str(spec_path)]
        generated_paths = [migration_receipt]
        if not approved.exists():
            generated_paths.append(approved)
        if not shot_path.exists():
            generated_paths.append(shot_path)
        _preflight_recordable_paths(recordable_paths, generated=generated_paths)
        for source, name in ((piece / table['file'], files['before_table']),
                             (spec_path, files['before_spec'])):
            target = leaf / name
            if not target.exists() and source.exists():
                target.write_bytes(source.read_bytes())
        if not shot_path.exists():
            write_json(leaf / files['before_table_absent'], {'path': str(shot_path), 'existed': False})
        write_json(approved, data)
        detail['root_adoption'] = {'recorded_at_local': datetime.now().astimezone().isoformat(),
                                   'source_input': files['input_copy'], 'intervals': data['intervals'],
                                   'native_text_records': data.get('words', []), 'open_endpoint': data['open_endpoint'],
                                   'membership_migrations': membership_readback,
                                   'scope': data['scope']}
        write_json(leaf / files['detail'], detail)
        out = io.StringIO()
        writer = csv.DictWriter(out, fields, delimiter='\t', lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)
        pending = piece / (table['file'] + '.pending')
        pending.write_text(out.getvalue())
        os.replace(pending, piece / table['file'])
        write_json(spec_path, spec)
        write_json(migration_receipt, membership_readback)
        question = P['question']
        investigation.record_evidence(store, piece, question['id'], question['status'],
                                      [str(approved), str(journal_path), str(detail_path),
                                       str(detail_note_path), str(migration_receipt),
                                       str(piece / table['file']), str(spec_path)],
                                      question['note'], question['label'], False, [], True)
        result = {'recorded_at_local': datetime.now().astimezone().isoformat(), 'source': spec['piece']['id'],
                  'intervals_added': added, 'canonical_interval_count': len(rows),
                  'new_word_slots': sum(len(wt_core.split_words(w['text'], registry)) for w in data.get('words', [])),
                  'scope': data['scope'], 'open_endpoint': data['open_endpoint'],
                  'membership_migrations': membership_readback,
                  'consumer_build': 'pending'}
        write_json(leaf / files['readback'], result)
        return result
