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

function textForValue(value, display = {}) {
  if (value === undefined || value === null || value === '') return String(display.empty ?? '');
  if (display.format === 'number' && typeof value === 'number') {
    return new Intl.NumberFormat(undefined, display.numberOptions ?? {}).format(value);
  }
  if (display.format === 'json') return JSON.stringify(value);
  return String(value);
}

function rowId(record, idPath) {
  const configured = readPath(record, idPath ?? ['record_id']);
  if (typeof configured === 'string' && configured) return configured;
  const fallback = readPath(record, ['id']);
  if (typeof fallback === 'string' && fallback) return fallback;
  throw new Error('Projection record has no stable id.');
}

function defaultMethods() {
  return {
    'field.equals': ({ record, params }) => Object.is(readPath(record, params?.field), params?.value),
    'field.notEquals': ({ record, params }) => !Object.is(readPath(record, params?.field), params?.value),
    'field.exists': ({ record, params }) => readPath(record, params?.field) !== undefined,
    'field.containsText': ({ record, params }) => {
      const value = readPath(record, params?.field);
      return String(value ?? '').toLowerCase().includes(String(params?.text ?? '').toLowerCase());
    },
    'related.count': ({ record, related, params }) => {
      const fromValue = readPath(record, Array.isArray(params?.from) ? params.from : [params?.from ?? 'record_id']);
      const toPath = Array.isArray(params?.to) ? params.to : [params?.to ?? 'subject_record_id'];
      return related.filter((entry) => Object.is(readPath(entry, toPath), fromValue)).length;
    },
  };
}

function methodTable(extraMethods = {}) {
  return { ...defaultMethods(), ...extraMethods };
}

function callMethod(methods, method, context) {
  const handler = methods[method];
  if (typeof handler !== 'function') {
    throw new Error(`Descriptor method is not registered: ${method}`);
  }
  return handler(context);
}

function fieldValues(record, fields) {
  const values = {};
  for (const field of fields) {
    if (!field || typeof field.id !== 'string') continue;
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
  for (const relationship of relationships) {
    if (!relationship || typeof relationship.id !== 'string') continue;
    values[relationship.id] = callMethod(methods, relationship.method, {
      record,
      related,
      params: relationship.params ?? {},
    });
  }
  return values;
}

function actionValues(actions, row, methods) {
  return actions.map((action) => {
    const enabledWhen = action?.enabledWhen;
    const enabled = enabledWhen
      ? Boolean(callMethod(methods, enabledWhen.method, {
          record: row,
          related: [],
          params: enabledWhen.params ?? {},
        }))
      : true;
    return {
      id: action.id,
      label: action.label,
      target: action.target,
      operation: action.operation,
      definitionId: action.definition_id ?? action.definitionId,
      input: action.input ?? {},
      copy: Array.isArray(action.copy) ? action.copy : [],
      enabled,
      disabledReason: enabled ? undefined : action.disabledReason,
    };
  });
}

export function validateRecordProjectionDescriptor(descriptor) {
  if (!isPlainRecord(descriptor)) throw new Error('Projection descriptor must be an object.');
  if (typeof descriptor.id !== 'string' || descriptor.id.length === 0) {
    throw new Error('Projection descriptor requires id.');
  }
  if (!isPlainRecord(descriptor.source) || typeof descriptor.source.address !== 'string') {
    throw new Error('Projection descriptor requires source.address.');
  }
  if (!Array.isArray(descriptor.fields)) throw new Error('Projection descriptor requires fields array.');
  for (const field of descriptor.fields) {
    if (!isPlainRecord(field) || typeof field.id !== 'string' || !Array.isArray(field.path)) {
      throw new Error('Projection field descriptors require id and path.');
    }
  }
  for (const collectionName of ['filters', 'relationships', 'actions']) {
    const collection = descriptor[collectionName];
    if (collection !== undefined && !Array.isArray(collection)) {
      throw new Error(`Projection descriptor ${collectionName} must be an array.`);
    }
  }
  return descriptor;
}

export function foldRecordProjection(input) {
  const descriptor = validateRecordProjectionDescriptor(input?.descriptor);
  const records = Array.isArray(input.records) ? input.records : [];
  const related = Array.isArray(input.related) ? input.related : [];
  const methods = methodTable(input.methods);
  const filters = descriptor.filters ?? [];
  const relationships = descriptor.relationships ?? [];
  const actions = descriptor.actions ?? [];
  const rows = [];

  for (const record of records) {
    if (!isPlainRecord(record)) continue;
    const include = filters.every((filter) =>
      Boolean(callMethod(methods, filter.method, { record, related, params: filter.params ?? {} })),
    );
    if (!include) continue;
    const recordId = rowId(record, descriptor.recordIdPath);
    const values = fieldValues(record, descriptor.fields);
    const relationValues = relationshipValues(record, relationships, related, methods);
    const row = {
      recordId,
      values,
      relationships: relationValues,
      source: record,
    };
    rows.push({
      ...row,
      actions: actionValues(actions, row, methods),
    });
  }

  return {
    projectionId: descriptor.id,
    source: descriptor.source,
    cursor: input.cursor ?? '',
    rows,
    proof: {
      recordCount: records.length,
      rowCount: rows.length,
      fieldCount: descriptor.fields.length,
      actionCount: actions.length,
      relationshipCount: relationships.length,
    },
  };
}
