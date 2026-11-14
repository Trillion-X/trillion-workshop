export type JsonRecord = Record<string, unknown>;

export interface WorkGraphDescriptor {
  id: string;
  kind: string;
  label?: string;
  method?: string;
  params?: JsonRecord;
  paths?: string[][];
  raw: JsonRecord;
}

export interface WorkGraphRecord {
  id: string;
  typeId: string;
  label: string;
  fields: JsonRecord;
  relationships: JsonRecord[];
  actions: WorkGraphAction[];
  raw: JsonRecord;
}

export interface WorkGraphAction {
  id: string;
  label: string;
  target: string;
  operation: string;
  definitionId?: string;
  input?: JsonRecord;
  disabledReason?: string;
  primary?: boolean;
}

export interface WorkGraphProjection {
  graph: {
    id: string;
    label: string;
    revision: string;
  };
  descriptors: WorkGraphDescriptor[];
  descriptorsByKind: Record<string, WorkGraphDescriptor[]>;
  records: WorkGraphRecord[];
  recordsByTypeId: Record<string, WorkGraphRecord[]>;
  actions: WorkGraphAction[];
  proof: {
    descriptorIds: string[];
    recordCountsByTypeId: Record<string, number>;
    actionIds: string[];
    issues: string[];
  };
}

const DESCRIPTOR_KINDS = new Set([
  'record_type',
  'field_descriptor',
  'relationship_descriptor',
  'rule_descriptor',
  'projection_descriptor',
  'action_descriptor',
  'proof_descriptor',
  'handoff_descriptor',
]);

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function pathList(value: unknown): string[][] {
  return records(value)
    .map((item) => textArray(item.path))
    .filter((path) => path.length > 0);
}

function payloadOf(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  return isRecord(value.payload) ? value.payload : isRecord(value.value) ? value.value : value;
}

function sourcePayloads(raw: unknown): JsonRecord[] {
  if (Array.isArray(raw)) return raw.map(payloadOf).filter((item) => Object.keys(item).length > 0);
  const source = payloadOf(raw);
  const buckets = [
    ...records(source.things).map(payloadOf),
    ...records(source.descriptors),
    ...records(source.source_records),
  ];
  return buckets.length > 0 ? buckets : [source];
}

function descriptorId(record: JsonRecord, index: number): string {
  return text(record.id ?? record.descriptor_id ?? record.ref, `descriptor:${index}`);
}

function toDescriptor(record: JsonRecord, index: number): WorkGraphDescriptor {
  return {
    id: descriptorId(record, index),
    kind: text(record.kind, 'unknown_descriptor'),
    label: text(record.label, '') || undefined,
    method: text(record.method, '') || undefined,
    params: isRecord(record.params) ? record.params : undefined,
    paths: pathList(record.paths),
    raw: record,
  };
}

function descriptorBucket(descriptors: WorkGraphDescriptor[]): Record<string, WorkGraphDescriptor[]> {
  const byKind: Record<string, WorkGraphDescriptor[]> = Object.create(null);
  for (const descriptor of descriptors) {
    byKind[descriptor.kind] = [...(byKind[descriptor.kind] ?? []), descriptor];
  }
  return byKind;
}

function firstPath(record: JsonRecord, paths: string[][]): unknown {
  for (const path of paths) {
    let next: unknown = record;
    for (const segment of path) {
      if (!isRecord(next)) {
        next = undefined;
        break;
      }
      next = next[segment];
    }
    if (next !== undefined) return next;
  }
  return undefined;
}

function recordId(record: JsonRecord, index: number): string {
  return text(record.id ?? record.ref ?? record.record_ref, `record:${index}`);
}

function recordTypeId(record: JsonRecord): string {
  return text(record.record_type_id ?? record.type_id ?? record.kind, 'record');
}

function recordLabel(record: JsonRecord, id: string): string {
  return text(record.label ?? record.title ?? record.summary ?? record.name, id);
}

function actionFromDescriptor(descriptor: WorkGraphDescriptor): WorkGraphAction {
  return {
    id: descriptor.id,
    label: text(descriptor.raw.label, descriptor.id),
    target: text(descriptor.raw.target, 'slot::workflow'),
    operation: text(descriptor.raw.operation, 'execute_definition'),
    definitionId: text(descriptor.raw.workflow_definition_ref ?? descriptor.raw.definition_id, '') || undefined,
    input: isRecord(descriptor.raw.input) ? descriptor.raw.input : undefined,
    disabledReason: text(descriptor.raw.disabled_reason, '') || undefined,
    primary: descriptor.raw.primary === true || undefined,
  };
}

function toRecord(record: JsonRecord, index: number, fields: WorkGraphDescriptor[], actions: WorkGraphAction[]): WorkGraphRecord {
  const id = recordId(record, index);
  const typeId = recordTypeId(record);
  const projectedFields: JsonRecord = {};
  for (const field of fields) {
    if (text(field.raw.record_type_ref, '') && field.raw.record_type_ref !== typeId) continue;
    const value = firstPath(record, field.paths ?? []);
    if (value !== undefined) projectedFields[field.id] = value;
  }
  return {
    id,
    typeId,
    label: recordLabel(record, id),
    fields: Object.keys(projectedFields).length > 0 ? projectedFields : { ...record },
    relationships: records(record.relationships),
    actions,
    raw: record,
  };
}

function countByType(rows: WorkGraphRecord[]): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const row of rows) counts[row.typeId] = (counts[row.typeId] ?? 0) + 1;
  return counts;
}

function bucketRows(rows: WorkGraphRecord[]): Record<string, WorkGraphRecord[]> {
  const byType: Record<string, WorkGraphRecord[]> = Object.create(null);
  for (const row of rows) byType[row.typeId] = [...(byType[row.typeId] ?? []), row];
  return byType;
}

function graphRevision(id: string, descriptors: WorkGraphDescriptor[], records: WorkGraphRecord[]): string {
  return [
    id,
    ...descriptors.map((descriptor) => `${descriptor.kind}:${descriptor.id}`),
    ...records.map((record) => `${record.typeId}:${record.id}:${text(record.raw.revision, '')}`),
  ].join('|');
}

export function readGenericRecordWorkGraph(raw: unknown): WorkGraphProjection {
  const payloads = sourcePayloads(raw);
  const graphPayload = payloads.find((payload) => text(payload.kind) === 'generic-record-work-graph') ?? payloadOf(raw);
  const graphId = text(graphPayload.id, 'generic-record-work-graph');
  const graphLabel = text(graphPayload.label, graphId);
  const graphDescriptors = records(graphPayload.descriptors);
  const payloadDescriptors = payloads.filter((payload) => DESCRIPTOR_KINDS.has(text(payload.kind)));
  const descriptors = [...graphDescriptors, ...payloadDescriptors]
    .map(toDescriptor)
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  const descriptorsByKind = descriptorBucket(descriptors);
  const fields = descriptorsByKind.field_descriptor ?? [];
  const actions = (descriptorsByKind.action_descriptor ?? []).map(actionFromDescriptor);
  const graphRecords = records(graphPayload.records);
  const payloadRecords = payloads.filter((payload) => !DESCRIPTOR_KINDS.has(text(payload.kind)) && text(payload.kind) !== 'generic-record-work-graph');
  const rows = [...graphRecords, ...payloadRecords].map((record, index) => toRecord(record, index, fields, actions));
  const issues = records(graphPayload.issues).map((issue) => text(issue.detail ?? issue.code, '')).filter(Boolean);

  return {
    graph: {
      id: graphId,
      label: graphLabel,
      revision: graphRevision(graphId, descriptors, rows),
    },
    descriptors,
    descriptorsByKind,
    records: rows,
    recordsByTypeId: bucketRows(rows),
    actions,
    proof: {
      descriptorIds: descriptors.map((descriptor) => descriptor.id),
      recordCountsByTypeId: countByType(rows),
      actionIds: actions.map((action) => action.id),
      issues,
    },
  };
}
