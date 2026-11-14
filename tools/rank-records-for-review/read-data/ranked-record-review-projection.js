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
      target: action.target,
      operation: action.operation,
      definition_id: action.definition_id,
      input: action.input ?? {},
      copy: asArray(action.copy),
      enabled,
      disabledReason: enabled ? undefined : action.disabledReason,
    };
  });
}

function rankFor(record, path) {
  const value = readPath(record, path ?? ['rank']);
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
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
    const row = {
      recordId: recordRef(record, descriptor.recordIdPath),
      candidateRecordRefs: asArray(record.candidate_record_refs),
      sourceRecordRefs: asArray(record.source_record_refs),
      evidenceRefs: asArray(record.evidence_refs),
      ruleRefs: asArray(record.rule_refs),
      displayDescriptorRefs: asArray(record.display_descriptor_refs),
      ownerActionDescriptorRefs: asArray(record.owner_action_descriptor_refs),
      processSessionRef: typeof record.process_session_ref === 'string' ? record.process_session_ref : undefined,
      idempotencyRef: typeof record.idempotency_ref === 'string' ? record.idempotency_ref : undefined,
      rank: rankFor(record, descriptor.rankPath),
      values: fieldValues(record, descriptor.fields),
      relationships: relationshipValues(record, descriptor.relationships, related, methods),
      statusKeys: statusKeys(record, descriptor.statusKeyPaths),
      source: record,
    };
    rows.push({
      ...row,
      actions: actionValues(descriptor.actions, row, methods),
    });
  }

  rows.sort((left, right) => left.rank - right.rank || left.recordId.localeCompare(right.recordId));
  console.log('[suggested-match] ranked-record-review projection folded', {
    recordCount: records.length,
    rowCount: rows.length,
  });

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

export function snapshotRankedReviewProjection({ state, descriptor, related = [], methods = {} }) {
  return foldRankedRecordReviewProjection({
    descriptor,
    records: Array.from((state?.byRef ?? new Map()).values()),
    related,
    methods,
    cursor: state?.cursor ?? '',
  });
}
