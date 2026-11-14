export type RecordMap = Record<string, unknown>;

export interface PublishedRecordRow {
  address?: string;
  payload?: unknown;
}

export interface WorkRecord {
  id: string;
  label: string;
  fields: RecordMap;
  relationRefs: string[];
  actionRefs: string[];
  ownerRefs: string[];
  stateRefs: string[];
  raw: RecordMap;
}

export interface WorkDescriptor {
  id: string;
  kind: string;
  label: string;
  order: number;
  target?: string;
  operation?: string;
  definitionId?: string;
  ownerRef?: string;
  permissionRef?: string;
  idempotencyKey?: string;
  input?: RecordMap;
  copy?: Array<{ key: string; from?: string; value?: unknown }>;
  fields?: Array<{ id: string; label: string; order: number }>;
  emptyCopy?: string;
}

export interface OwnerEvidence {
  ref: string;
  ownerRef: string;
  label: string;
  summary?: string;
  time?: string;
  stateLabel?: string;
  raw: RecordMap;
}

export interface RecordWorkGraphInput {
  records?: PublishedRecordRow[];
  workRecords?: unknown[];
  fieldDescriptors?: unknown[];
  relationDescriptors?: unknown[];
  viewDescriptors?: unknown[];
  actionDescriptors?: unknown[];
  ruleDescriptors?: unknown[];
  projectionDescriptors?: unknown[];
  ownerEvidence?: unknown[];
  copyDescriptors?: unknown[];
}

export interface RecordWorkGraph {
  workRecords: WorkRecord[];
  fieldDescriptors: WorkDescriptor[];
  relationDescriptors: WorkDescriptor[];
  viewDescriptors: WorkDescriptor[];
  actionDescriptors: WorkDescriptor[];
  ruleDescriptors: WorkDescriptor[];
  projectionDescriptors: WorkDescriptor[];
  ownerEvidence: OwnerEvidence[];
  copyDescriptors: WorkDescriptor[];
}

const KINDS = {
  workRecord: 'record-work.record',
  field: 'record-work.field-descriptor',
  relation: 'record-work.relation-descriptor',
  view: 'record-work.view-descriptor',
  action: 'record-work.action-descriptor',
  rule: 'record-work.rule-descriptor',
  projection: 'record-work.projection-descriptor',
  evidence: 'record-work.owner-evidence',
  copy: 'record-work.copy-descriptor',
} as const;

export function isObject(value: unknown): value is RecordMap {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function objects(value: unknown): RecordMap[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function payloads(rows: PublishedRecordRow[] | undefined, kind: string): RecordMap[] {
  return (rows ?? [])
    .map((row) => row.payload)
    .filter((payload): payload is RecordMap => isObject(payload) && payload.kind === kind);
}

function allRows(input: RecordWorkGraphInput, explicit: unknown[] | undefined, kind: string): RecordMap[] {
  return [...objects(explicit), ...payloads(input.records, kind)];
}

function copyRules(value: unknown): WorkDescriptor['copy'] {
  const entries = objects(value)
    .map((entry) => ({
      key: text(entry.key),
      from: text(entry.from) || undefined,
      value: entry.value,
    }))
    .filter((entry) => entry.key);
  return entries.length > 0 ? entries : undefined;
}

function descriptor(record: RecordMap, fallbackPrefix: string, index: number): WorkDescriptor {
  const id = text(record.id ?? record.ref ?? record.descriptor_ref, `${fallbackPrefix}:${index}`);
  return {
    id,
    kind: text(record.kind, 'record-work.descriptor'),
    label: text(record.label, id),
    order: number(record.order, index),
    target: text(record.target) || undefined,
    operation: text(record.operation) || undefined,
    definitionId: text(record.definition_id ?? record.definitionId) || undefined,
    ownerRef: text(record.owner_ref ?? record.ownerRef) || undefined,
    permissionRef: text(record.permission_ref ?? record.permissionRef) || undefined,
    idempotencyKey: text(record.idempotency_key ?? record.idempotencyKey) || undefined,
    input: isObject(record.input) ? record.input : undefined,
    copy: copyRules(record.copy),
    emptyCopy: text(record.empty_copy ?? record.emptyCopy) || undefined,
    fields: objects(record.fields).map((field, fieldIndex) => ({
      id: text(field.id, `field:${fieldIndex}`),
      label: text(field.label, text(field.id, `Field ${fieldIndex + 1}`)),
      order: number(field.order, fieldIndex),
    })),
  };
}

function descriptors(records: RecordMap[], fallbackPrefix: string): WorkDescriptor[] {
  return records
    .map((record, index) => descriptor(record, fallbackPrefix, index))
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function workRecord(record: RecordMap, index: number): WorkRecord {
  const id = text(record.id ?? record.ref ?? record.record_ref, `record-work:${index}`);
  return {
    id,
    label: text(record.label ?? record.title ?? record.name, id),
    fields: isObject(record.fields) ? record.fields : isObject(record.field_values) ? record.field_values : {},
    relationRefs: stringList(record.relation_refs ?? record.relationRefs),
    actionRefs: stringList(record.action_refs ?? record.actionRefs),
    ownerRefs: stringList(record.owner_refs ?? record.ownerRefs),
    stateRefs: stringList(record.state_refs ?? record.stateRefs),
    raw: record,
  };
}

function ownerEvidence(record: RecordMap, index: number): OwnerEvidence {
  const ref = text(record.ref ?? record.id, `owner-evidence:${index}`);
  return {
    ref,
    ownerRef: text(record.owner_ref ?? record.ownerRef),
    label: text(record.label ?? record.title, ref),
    summary: text(record.summary) || undefined,
    time: text(record.time ?? record.observed_at ?? record.observedAt) || undefined,
    stateLabel: text(record.state_label ?? record.stateLabel) || undefined,
    raw: record,
  };
}

export function readRecordWorkGraph(input: RecordWorkGraphInput): RecordWorkGraph {
  const workRecords = allRows(input, input.workRecords, KINDS.workRecord).map(workRecord);
  return {
    workRecords,
    fieldDescriptors: descriptors(allRows(input, input.fieldDescriptors, KINDS.field), 'field'),
    relationDescriptors: descriptors(allRows(input, input.relationDescriptors, KINDS.relation), 'relation'),
    viewDescriptors: descriptors(allRows(input, input.viewDescriptors, KINDS.view), 'view'),
    actionDescriptors: descriptors(allRows(input, input.actionDescriptors, KINDS.action), 'action'),
    ruleDescriptors: descriptors(allRows(input, input.ruleDescriptors, KINDS.rule), 'rule'),
    projectionDescriptors: descriptors(allRows(input, input.projectionDescriptors, KINDS.projection), 'projection'),
    ownerEvidence: allRows(input, input.ownerEvidence, KINDS.evidence).map(ownerEvidence),
    copyDescriptors: descriptors(allRows(input, input.copyDescriptors, KINDS.copy), 'copy'),
  };
}

