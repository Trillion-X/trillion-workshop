// Turns one step on a queue of work records (edit a field, link a record, add a receipt, correct a record) into the
// operation that records it, and folds operations into the queue. A step whose action names an owner (a `target` or a
// `definition_id`) is not run here: it comes back as a handoff with its inputs bound from the sources, for whatever
// tool does that job.

export type AnyRecord = Record<string, unknown>;

export interface BindingRule {
  key: string;
  source?: string;
  path?: string[];
  value?: unknown;
}

export interface GenericActionDescriptor {
  id: string;
  label?: string;
  method: string;
  target?: string;
  definitionId?: string;
  definition_id?: string;
  patch?: AnyRecord;
  params?: AnyRecord;
  bindings?: BindingRule[];
}

export interface RecordStepContext {
  operationId: string;
  descriptorId?: string;
  method?: string;
  recordId?: string;
  fieldPatch?: AnyRecord;
  relationshipPatch?: Record<string, string[]>;
  receipt?: AnyRecord;
  correction?: AnyRecord;
  expectedBasis?: string;
  actor?: string;
  observedAt?: string;
  sources?: Record<string, unknown>;
  descriptors?: GenericActionDescriptor[];
}

export interface Handoff {
  actionId: string;
  method: string;
  target?: string;
  definitionId?: string;
  input: AnyRecord;
}

export interface RecordStepResult {
  recordOperations: AnyRecord[];
  handoffs: Handoff[];
  errors: Array<{ code: string; detail: string }>;
  trace: {
    descriptorId?: string;
    method?: string;
    target?: string;
    bindingKeys: string[];
    expectedBasis?: string;
  };
}

const LOCAL_METHODS = new Set([
  'create-record',
  'update-field',
  'link-record',
  'unlink-record',
  'append-receipt',
  'correct-record',
  'archive-record',
  'restore-record',
]);

function isObject(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readPath(source: unknown, path: string[] = []): unknown {
  return path.reduce((current, segment) => (isObject(current) ? current[segment] : undefined), source);
}

function bindingInput(
  descriptor: GenericActionDescriptor,
  context: RecordStepContext,
): { input: AnyRecord; keys: string[] } {
  const input = { ...(descriptor.params ?? {}) };
  const keys: string[] = [];
  for (const rule of descriptor.bindings ?? []) {
    const value = rule.value !== undefined
      ? rule.value
      : readPath(context.sources?.[text(rule.source)], rule.path);
    if (value !== undefined) {
      input[rule.key] = value;
      keys.push(rule.key);
    }
  }
  return { input, keys };
}

function localOperation(
  context: RecordStepContext,
  descriptor: GenericActionDescriptor | undefined,
  method: string,
): AnyRecord {
  return {
    kind: 'generic.record-action-operation',
    operation_id: context.operationId,
    descriptor_id: descriptor?.id ?? context.descriptorId ?? null,
    method,
    record_id: context.recordId ?? null,
    field_patch: {
      ...(descriptor?.patch ?? {}),
      ...(context.fieldPatch ?? {}),
    },
    relationship_patch: context.relationshipPatch ?? {},
    receipt: context.receipt ?? null,
    correction: context.correction ?? null,
    expected_basis: context.expectedBasis ?? null,
    actor: context.actor ?? null,
    observed_at: context.observedAt ?? null,
  };
}

export function buildRecordStep(context: RecordStepContext): RecordStepResult {
  const errors: RecordStepResult['errors'] = [];
  if (!context.operationId) errors.push({ code: 'missing-operation', detail: 'operationId is required' });
  const descriptor = context.descriptorId
    ? (context.descriptors ?? []).find((entry) => entry.id === context.descriptorId)
    : undefined;
  if (context.descriptorId && !descriptor) errors.push({ code: 'missing-descriptor', detail: context.descriptorId });

  const method = text(descriptor?.method ?? context.method, 'update-field');
  const definitionId = text(descriptor?.definitionId ?? descriptor?.definition_id, '');
  if (!descriptor?.target && !definitionId && !LOCAL_METHODS.has(method)) {
    errors.push({ code: 'unknown-method', detail: method });
  }
  if (errors.length > 0) {
    return {
      recordOperations: [],
      handoffs: [],
      errors,
      trace: { descriptorId: context.descriptorId, method, bindingKeys: [], expectedBasis: context.expectedBasis },
    };
  }

  const binding = descriptor ? bindingInput(descriptor, context) : { input: {}, keys: [] };
  const trace = {
    descriptorId: descriptor?.id,
    method,
    target: descriptor?.target,
    bindingKeys: binding.keys,
    expectedBasis: context.expectedBasis,
  };
  if (descriptor && (descriptor.target || definitionId)) {
    return {
      recordOperations: [],
      handoffs: [{
        actionId: descriptor.id,
        method,
        ...(descriptor.target ? { target: descriptor.target } : {}),
        ...(definitionId ? { definitionId } : {}),
        input: binding.input,
      }],
      errors: [],
      trace,
    };
  }

  return { recordOperations: [localOperation(context, descriptor, method)], handoffs: [], errors: [], trace };
}

// The state of the queue (empty, sparse, dense) is not stored here: the reader works it out from the records and the
// view's density threshold, so there is one place that says it.
export function materializeRecordActionGraph(current: AnyRecord, operations: AnyRecord[]): AnyRecord {
  const records = Array.isArray(current.records) ? current.records.filter(isObject).map((entry) => ({ ...entry })) : [];
  const receipts = Array.isArray(current.receipts) ? current.receipts.filter(isObject).map((entry) => ({ ...entry })) : [];
  for (const operation of operations) {
    const recordId = text(operation.record_id, '') || `record:${text(operation.operation_id, 'operation')}`;
    const index = records.findIndex((record) => text(record.id) === recordId);
    const existing = index >= 0 ? records[index] : { id: recordId, title: recordId, fields: {}, relationships: {} };
    const fields = isObject(existing.fields) ? existing.fields : {};
    const relationships = isObject(existing.relationships) ? existing.relationships : {};
    const next = {
      ...existing,
      fields: { ...fields, ...(isObject(operation.field_patch) ? operation.field_patch : {}) },
      relationships: { ...relationships, ...(isObject(operation.relationship_patch) ? operation.relationship_patch : {}) },
    };
    if (index >= 0) records[index] = next;
    else records.push(next);
    if (isObject(operation.receipt)) {
      receipts.push({
        kind: 'generic.receipt-record',
        id: text(operation.receipt.id, `receipt:${text(operation.operation_id, 'operation')}`),
        record_id: recordId,
        action_id: operation.descriptor_id,
        ...operation.receipt,
      });
    }
    if (isObject(operation.correction)) {
      receipts.push({
        kind: 'generic.receipt-record',
        id: text(operation.correction.id, `correction:${text(operation.operation_id, 'operation')}`),
        record_id: recordId,
        action_id: operation.descriptor_id,
        correction: operation.correction,
      });
    }
  }
  const { state: _stored, ...rest } = current;
  return { ...rest, records, receipts };
}
