// tools/rank-records-for-review/read-data/rank-records-for-review.mjs
//
// Purpose
//   Ranks a person's records for review by the descriptor they give (which records, which fields to show, how to rank,
//   what each row is related to, which actions apply), and puts on each row where the person already stands on it:
//   accepted (agree), passed (disagree), partly, or nothing yet. A pure fold: records, related records, the person's
//   stands and a descriptor in; ranked rows out.
//
// Non-negotiable invariants
//   1. Every word about a domain is DATA in the descriptor: fields, filters, relationships, status key paths, actions
//      and their labels. The code knows records, paths, ranks and refs only.
//   2. A filter, a relationship and an action's enabledWhen name a method in the method table; a caller may add methods,
//      and an unknown method is refused, never guessed.
//   3. Rows come smallest rank first, then by record ref, so the same records always give the same order. A record with
//      no rank (not a finite number) has `rank: null` on its row and comes after every ranked row.
//   4. Accept and pass are the person's stands on the row, kept by tools/where-a-person-stands
//      (tool:keep-where-you-stand). The thing stood on is the descriptor's `standView` (the parts of the record that
//      name the suggestion) as a JSON view of kind `standKind`. That tool identifies a view by the bytes of its JSON
//      text, so a stand is on a row when it is of the row's kind and its view has the same JSON text: this fold compares
//      the bytes the identity is made from and makes no identity of its own. This folder writes no stand. Of the stands
//      given for a row, the newest governs, and a newest that takes the stand back (no stance) means no stand: an
//      older stand in the same history is never revived.
//
// Ported from bitfield-packages packages/suggested-match/read-data/ranked-record-review-projection.js: the method table,
// field values, relationships, status keys, rank order, filters, maintained state (create, apply events, snapshot) and
// the descriptor check are the same. Changed: an action is { id, label, stance, enabledWhen?, disabledReason?, copy? }
// (the old engine target, operation and workflow definition are gone: do-work/stand-request.mjs builds the stand
// request), each row carries standView and the person's stand, the descriptor names standView and standKind, the old
// engine's process-session, display-descriptor and owner-action-descriptor refs are not read, and the fold writes no
// log line.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export function isPlainRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readPath(value, path) {
  if (!Array.isArray(path)) return undefined;
  let current = value;
  for (const segment of path) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isPlainRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function textForValue(value, display = {}) {
  if (value === undefined || value === null || value === '') return String(display.empty ?? '');
  if (display.format === 'number' && typeof value === 'number') {
    return new Intl.NumberFormat(undefined, display.numberOptions ?? {}).format(value);
  }
  if (display.format === 'json') return JSON.stringify(value);
  return String(value);
}

function recordRef(record, path) {
  const configured = readPath(record, path ?? ['record_ref']);
  if (typeof configured === 'string' && configured) return configured;
  const id = readPath(record, ['id']);
  if (typeof id === 'string' && id) return id;
  throw new Error('Ranked review record has no stable ref.');
}

function defaultMethods() {
  return {
    'field.exists': ({ record, params }) => readPath(record, params?.field) !== undefined,
    'field.equals': ({ record, params }) => Object.is(readPath(record, params?.field), params?.value),
    'field.notEquals': ({ record, params }) => !Object.is(readPath(record, params?.field), params?.value),
    'refs.count': ({ record, params }) => asArray(readPath(record, params?.field)).length,
  };
}

function methodTable(extraMethods = {}) {
  return { ...defaultMethods(), ...extraMethods };
}

function callMethod(methods, method, context) {
  const handler = methods[method];
  if (typeof handler !== 'function') throw new Error(`Descriptor method is not registered: ${method}`);
  return handler(context);
}

function fieldValues(record, fields) {
  const values = {};
  for (const field of asArray(fields)) {
    if (!isPlainRecord(field) || typeof field.id !== 'string') continue;
    const raw = readPath(record, field.path);
    values[field.id] = {
      fieldId: field.id,
      role: typeof field.role === 'string' ? field.role : undefined,
      raw,
      text: textForValue(raw, field.display),
      display: field.display ?? {},
    };
  }
  return values;
}

function relationshipValues(record, relationships, related, methods) {
  const values = {};
  for (const relationship of asArray(relationships)) {
    if (!isPlainRecord(relationship) || typeof relationship.id !== 'string') continue;
    values[relationship.id] = callMethod(methods, relationship.method, {
      record,
      related,
      params: relationship.params ?? {},
    });
  }
  return values;
}

function statusKeys(record, statusKeyPaths = {}) {
  const keys = {};
  for (const [dimension, path] of Object.entries(statusKeyPaths)) {
    const raw = readPath(record, path);
    if (typeof raw === 'string' && raw) keys[dimension] = raw;
  }
  return keys;
}

function actionValues(actions, row, methods) {
  return asArray(actions).map((action) => {
    const enabledWhen = action?.enabledWhen;
    const enabled = enabledWhen
      ? Boolean(callMethod(methods, enabledWhen.method, {
          record: row.source,
          row,
          related: [],
          params: enabledWhen.params ?? {},
        }))
      : true;
    return {
      id: action.id,
      label: action.label,
      stance: action.stance,
      copy: asArray(action.copy),
      enabled,
      disabledReason: enabled ? undefined : action.disabledReason,
    };
  });
}

// The record's rank, or null when it has none (not a finite number). A row with no rank is emitted with `rank: null`
// (JSON has no Infinity) and comes after every ranked row.
function rankFor(record, path) {
  const value = readPath(record, path ?? ['rank']);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const byRankThenRef = (left, right) => (left.rank ?? Number.POSITIVE_INFINITY) - (right.rank ?? Number.POSITIVE_INFINITY)
  || left.recordId.localeCompare(right.recordId);

/** The parts of a record that name the suggestion a person stands on: { key: value at the descriptor's path, or null }. */
export function standViewOf(record, descriptor) {
  const view = {};
  for (const [key, path] of Object.entries(descriptor.standView)) view[key] = readPath(record, path) ?? null;
  return view;
}

// Every version of the stand of the row's kind on the same view (the same JSON text), in the order given.
function standVersions(view, kind, stands) {
  const text = JSON.stringify(view);
  return asArray(stands).filter((stand) => isPlainRecord(stand) && stand.kind === kind
    && stand.view !== undefined && JSON.stringify(stand.view) === text);
}

// The newest of those versions, or null. The newest is picked among every version given, taken back or not, and only
// then judged: a newest version that takes the stand back (no stance) means no stand, so an older agree or disagree in
// the history passed in is never revived. Of two with the same `at`, the later one in the list is newer.
const newestOf = (versions) =>
  versions.reduce((best, stand) => (best && (best.at ?? '') > (stand.at ?? '') ? best : stand), null);

// The version of the stand on the row, taken back or not, or '' when there is none. A request's idempotency ref carries
// it, so the same act asked again after the stand has changed is a new act with a new ref. It is the newest version's
// time (`at`); a version kept without a time is named by its place in the history (`n3`, the third version), so accept,
// pass, accept, pass never repeats a ref.
function standVersionOf(versions, newest) {
  if (!newest) return '';
  return typeof newest.at === 'string' && newest.at ? newest.at : `n${versions.length}`;
}

export function validateRankedRecordReviewDescriptor(descriptor) {
  if (!isPlainRecord(descriptor)) throw new Error('Ranked review descriptor must be an object.');
  if (typeof descriptor.id !== 'string' || descriptor.id.length === 0) {
    throw new Error('Ranked review descriptor requires id.');
  }
  if (!isPlainRecord(descriptor.source) || typeof descriptor.source.address !== 'string') {
    throw new Error('Ranked review descriptor requires source.address.');
  }
  if (!Array.isArray(descriptor.fields)) throw new Error('Ranked review descriptor requires fields array.');
  for (const field of descriptor.fields) {
    if (!isPlainRecord(field) || typeof field.id !== 'string' || !Array.isArray(field.path)) {
      throw new Error('Ranked review fields require id and path.');
    }
  }
  for (const key of ['filters', 'relationships', 'actions']) {
    if (descriptor[key] !== undefined && !Array.isArray(descriptor[key])) {
      throw new Error(`Ranked review descriptor ${key} must be an array.`);
    }
  }
  if (!isPlainRecord(descriptor.standView) || !Object.keys(descriptor.standView).length
    || Object.values(descriptor.standView).some((path) => !Array.isArray(path))) {
    throw new Error('Ranked review descriptor requires standView: { key: path } naming the parts of a record a stand is on.');
  }
  if (typeof descriptor.standKind !== 'string' || !descriptor.standKind || descriptor.standKind.includes('/')) {
    throw new Error('Ranked review descriptor requires standKind: the kind of thing a stand on a row is on, one word without "/".');
  }
  return descriptor;
}

export function foldRankedRecordReviewProjection(input = {}) {
  const descriptor = validateRankedRecordReviewDescriptor(input.descriptor);
  const records = asArray(input.records);
  const related = asArray(input.related);
  const methods = methodTable(input.methods);
  const rows = [];

  for (const record of records) {
    if (!isPlainRecord(record)) continue;
    const include = asArray(descriptor.filters).every((filter) =>
      Boolean(callMethod(methods, filter.method, { record, related, params: filter.params ?? {} })),
    );
    if (!include) continue;
    const standView = standViewOf(record, descriptor);
    const versions = standVersions(standView, descriptor.standKind, input.stands);
    const newest = newestOf(versions);
    const row = {
      recordId: recordRef(record, descriptor.recordIdPath),
      candidateRecordRefs: asArray(record.candidate_record_refs),
      sourceRecordRefs: asArray(record.source_record_refs),
      evidenceRefs: asArray(record.evidence_refs),
      ruleRefs: asArray(record.rule_refs),
      idempotencyRef: typeof record.idempotency_ref === 'string' ? record.idempotency_ref : undefined,
      rank: rankFor(record, descriptor.rankPath),
      values: fieldValues(record, descriptor.fields),
      relationships: relationshipValues(record, descriptor.relationships, related, methods),
      statusKeys: statusKeys(record, descriptor.statusKeyPaths),
      standKind: descriptor.standKind,
      standView,
      stand: newest?.stance ? newest : null,
      standVersion: standVersionOf(versions, newest),
      source: record,
    };
    rows.push({
      ...row,
      actions: actionValues(descriptor.actions, row, methods),
    });
  }

  rows.sort(byRankThenRef);

  return {
    projectionId: descriptor.id,
    source: descriptor.source,
    cursor: input.cursor ?? '',
    rows,
    proof: {
      recordCount: records.length,
      rowCount: rows.length,
      fieldCount: descriptor.fields.length,
      actionCount: asArray(descriptor.actions).length,
      relationshipCount: asArray(descriptor.relationships).length,
      stoodCount: rows.filter((row) => row.stand).length,
    },
  };
}

export function createRankedReviewState(records = []) {
  const byRef = new Map();
  for (const record of asArray(records)) {
    if (!isPlainRecord(record)) continue;
    const ref = record.record_ref ?? record.id;
    if (typeof ref === 'string' && ref) byRef.set(ref, record);
  }
  return { byRef, cursor: '' };
}

export function applyRankedReviewEvents(state, events) {
  const next = {
    byRef: new Map(state?.byRef ?? []),
    cursor: state?.cursor ?? '',
  };
  for (const event of asArray(events)) {
    if (!isPlainRecord(event)) continue;
    const ref = event.record_ref ?? event.recordRef;
    if (event.op === 'delete' && typeof ref === 'string') next.byRef.delete(ref);
    if (event.op === 'upsert' && isPlainRecord(event.record)) {
      const recordRefValue = event.record.record_ref ?? event.record.id;
      if (typeof recordRefValue === 'string' && recordRefValue) next.byRef.set(recordRefValue, event.record);
    }
    if (typeof event.cursor === 'string') next.cursor = event.cursor;
  }
  return next;
}

export function snapshotRankedReviewProjection({ state, descriptor, related = [], methods = {}, stands = [] }) {
  return foldRankedRecordReviewProjection({
    descriptor,
    records: Array.from((state?.byRef ?? new Map()).values()),
    related,
    methods,
    stands,
    cursor: state?.cursor ?? '',
  });
}
