export type AnyRecord = Record<string, unknown>;

export type RequestIntakeRenderState = 'empty' | 'sparse' | 'dense' | 'loading' | 'error' | 'offline' | 'conflict';

export interface PublishedRecordRow {
  address?: string;
  payload?: unknown;
}

export interface RequestIntakeDescriptor {
  id: string;
  label: string;
  order: number;
  kind?: string;
  target?: string;
  operation?: string;
  definitionId?: string;
  definitionIds: string[];
  input?: AnyRecord;
  copy: Array<{ key: string; from?: string; value?: unknown }>;
  fields: RequestIntakeFieldDescriptor[];
  disabledReason?: string;
  selected?: boolean;
  count?: number;
}

export interface RequestIntakeFieldDescriptor {
  id: string;
  label: string;
  order: number;
  valueKind?: string;
  required?: boolean;
  rules: RequestIntakeDescriptor[];
}

export interface RequestIntakeShape {
  id: string;
  label: string;
  order: number;
  versionRef?: string;
  fields: RequestIntakeFieldDescriptor[];
  actions: RequestIntakeDescriptor[];
  views: RequestIntakeDescriptor[];
  sharePolicies: RequestIntakeDescriptor[];
  raw?: unknown;
}

export interface RequestIntakeValue {
  fieldId: string;
  label: string;
  value: unknown;
  valueText: string;
}

export interface RequestIntakeRecordInstance {
  id: string;
  shapeId: string;
  title: string;
  stateId?: string;
  sourceLabel?: string;
  receivedAt?: string;
  values: RequestIntakeValue[];
  linkedReceiptRefs: string[];
  actionDescriptorIds: string[];
  issue?: string;
  raw?: unknown;
}

export interface RequestIntakeReceipt {
  ref: string;
  ownerRef: string;
  title: string;
  summary?: string;
  time?: string;
  state?: string;
  processSessionRef?: string;
  raw?: unknown;
}

export interface RequestIntakeSelectedRecord extends RequestIntakeRecordInstance {
  linkedReceipts: RequestIntakeReceipt[];
  actions: RequestIntakeDescriptor[];
}

export interface RequestIntakeSurfaceData {
  status: RequestIntakeRenderState;
  shapes: RequestIntakeShape[];
  views: RequestIntakeDescriptor[];
  states: RequestIntakeDescriptor[];
  actions: RequestIntakeDescriptor[];
  receipts: RequestIntakeReceipt[];
  records: RequestIntakeRecordInstance[];
  selectedShape: RequestIntakeShape | null;
  selectedRecord: RequestIntakeSelectedRecord | null;
  issues: string[];
}

export interface RequestIntakeProjectionInput {
  records?: PublishedRecordRow[];
  shapes?: AnyRecord[];
  fields?: AnyRecord[];
  rules?: AnyRecord[];
  views?: AnyRecord[];
  states?: AnyRecord[];
  actions?: AnyRecord[];
  sharePolicies?: AnyRecord[];
  instances?: AnyRecord[];
  receipts?: AnyRecord[];
  selectedShapeId?: string;
  selectedRecordId?: string;
  status?: RequestIntakeRenderState;
  issues?: string[];
}

const KIND = {
  shape: 'generic.record-shape',
  field: 'generic.field-descriptor',
  rule: 'generic.rule-descriptor',
  view: 'generic.view-descriptor',
  state: 'generic.state-descriptor',
  action: 'generic.owner-action-descriptor',
  sharePolicy: 'generic.share-policy-descriptor',
  instance: 'generic.record-instance',
  receipt: 'generic.owner-receipt',
} as const;

function isObject(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function payloads(rows: PublishedRecordRow[] | undefined, kind: string): AnyRecord[] {
  return (rows ?? [])
    .map((row) => row.payload)
    .filter((payload): payload is AnyRecord => isObject(payload) && payload.kind === kind);
}

function recordPayloads(rows: PublishedRecordRow[] | undefined): AnyRecord[] {
  return (rows ?? [])
    .map((row) => (isObject(row.payload) ? row.payload : isObject(row) ? row : null))
    .filter((payload): payload is AnyRecord => isObject(payload));
}

function descriptorGraphs(rows: PublishedRecordRow[] | undefined): AnyRecord[] {
  return recordPayloads(rows).filter((payload) =>
    payload.kind === 'request-intake.generic-record-graph'
    || Array.isArray(payload.record_shapes)
    || Array.isArray(payload.recordShapes),
  );
}

function graphObjects(graphs: AnyRecord[], snakeKey: string, camelKey: string): AnyRecord[] {
  return graphs.flatMap((graph) => objects(graph[snakeKey] ?? graph[camelKey]));
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function objects(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function copyRules(value: unknown): RequestIntakeDescriptor['copy'] {
  return objects(value)
    .map((entry) => ({
      key: text(entry.key, ''),
      from: text(entry.from, '') || undefined,
      value: entry.value,
    }))
    .filter((entry) => entry.key.length > 0);
}

function descriptor(record: AnyRecord, fallbackIdPrefix: string, index: number): RequestIntakeDescriptor {
  const id = text(record.id ?? record.ref ?? record.descriptor_ref, `${fallbackIdPrefix}:${index}`);
  return {
    id,
    label: text(record.label, id),
    order: number(record.order, index),
    kind: text(record.kind, '') || undefined,
    target: text(record.target, '') || undefined,
    operation: text(record.operation, '') || undefined,
    definitionId: text(record.definition_id ?? record.definitionId, '') || undefined,
    definitionIds: stringList(record.definition_ids ?? record.definitionIds),
    input: isObject(record.input) ? record.input : undefined,
    copy: copyRules(record.copy),
    fields: fieldDescriptors(objects(record.fields)),
    disabledReason: text(record.disabled_reason ?? record.disabledReason, '') || undefined,
    selected: record.selected === true,
    count: typeof record.count === 'number' ? record.count : undefined,
  };
}

function sortDescriptors(records: AnyRecord[], fallbackIdPrefix: string): RequestIntakeDescriptor[] {
  return records
    .map((record, index) => descriptor(record, fallbackIdPrefix, index))
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function fieldDescriptor(record: AnyRecord, index: number): RequestIntakeFieldDescriptor {
  const id = text(record.id ?? record.ref ?? record.field_ref, `field:${index}`);
  return {
    id,
    label: text(record.label, id),
    order: number(record.order, index),
    valueKind: text(record.value_kind ?? record.valueKind, '') || undefined,
    required: record.required === true,
    rules: sortDescriptors(objects(record.rules), 'rule'),
  };
}

function fieldDescriptors(records: AnyRecord[]): RequestIntakeFieldDescriptor[] {
  return records.map(fieldDescriptor).sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length === 1 ? '1 value' : `${value.length} values`;
  return 'Available';
}

function shape(record: AnyRecord, index: number, fieldsByShape: Map<string, RequestIntakeFieldDescriptor[]>): RequestIntakeShape {
  const id = text(record.id ?? record.ref ?? record.shape_ref, `shape:${index}`);
  return {
    id,
    label: text(record.label, id),
    order: number(record.order, index),
    versionRef: text(record.version_ref ?? record.versionRef, '') || undefined,
    fields: fieldsByShape.get(id) ?? fieldDescriptors(objects(record.fields)),
    actions: sortDescriptors(objects(record.actions), 'action'),
    views: sortDescriptors(objects(record.views), 'view'),
    sharePolicies: sortDescriptors(objects(record.share_policies ?? record.sharePolicies), 'share-policy'),
    raw: record.raw ?? record,
  };
}

function receipt(record: AnyRecord, index: number): RequestIntakeReceipt {
  const ref = text(record.ref ?? record.id ?? record.receipt_ref, `receipt:${index}`);
  return {
    ref,
    ownerRef: text(record.owner_ref ?? record.ownerRef, ''),
    title: text(record.title ?? record.label, ref),
    summary: text(record.summary, ''),
    time: text(record.time ?? record.observed_at ?? record.observedAt, ''),
    state: text(record.state ?? record.status, ''),
    processSessionRef: text(record.process_session_ref ?? record.processSessionRef, '') || undefined,
    raw: record.raw ?? record,
  };
}

function instance(
  record: AnyRecord,
  index: number,
  shapeById: Map<string, RequestIntakeShape>,
): RequestIntakeRecordInstance {
  const id = text(record.id ?? record.ref ?? record.instance_ref, `record:${index}`);
  const shapeId = text(record.shape_id ?? record.shapeId, '');
  const fields = shapeById.get(shapeId)?.fields ?? [];
  const rawValues = isObject(record.values) ? record.values : isObject(record.field_values) ? record.field_values : {};
  const values = fields.map((field) => ({
    fieldId: field.id,
    label: field.label,
    value: rawValues[field.id],
    valueText: displayValue(rawValues[field.id]),
  }));
  return {
    id,
    shapeId,
    title: text(record.title ?? record.label ?? record.name, id),
    stateId: text(record.state_id ?? record.stateId ?? record.status_id ?? record.statusId, '') || undefined,
    sourceLabel: text(record.source_label ?? record.sourceLabel, '') || undefined,
    receivedAt: text(record.received_at ?? record.receivedAt, '') || undefined,
    values,
    linkedReceiptRefs: stringList(record.linked_receipt_refs ?? record.linkedReceiptRefs),
    actionDescriptorIds: stringList(record.action_descriptor_ids ?? record.actionDescriptorIds),
    issue: text(record.issue, '') || undefined,
    raw: record,
  };
}

function deriveStatus(
  explicit: RequestIntakeRenderState | undefined,
  records: RequestIntakeRecordInstance[],
  issues: string[],
): RequestIntakeRenderState {
  if (explicit) return explicit;
  if (issues.length > 0 || records.some((record) => record.issue)) return 'conflict';
  if (records.length === 0) return 'empty';
  return records.length > 12 ? 'dense' : 'sparse';
}

export function readRequestIntakeSurface(input: RequestIntakeProjectionInput): RequestIntakeSurfaceData {
  const graphs = descriptorGraphs(input.records);
  const fieldRows = [
    ...(input.fields ?? []),
    ...graphObjects(graphs, 'field_descriptors', 'fieldDescriptors'),
    ...payloads(input.records, KIND.field),
  ];
  const fieldsByShape = new Map<string, RequestIntakeFieldDescriptor[]>();
  for (const field of fieldRows) {
    const shapeId = text(field.shape_id ?? field.shapeId, '');
    if (!shapeId) continue;
    const current = fieldsByShape.get(shapeId) ?? [];
    current.push(fieldDescriptor(field, current.length));
    fieldsByShape.set(shapeId, current.sort((left, right) => left.order - right.order || left.label.localeCompare(right.label)));
  }

  const shapes = [
    ...(input.shapes ?? []),
    ...graphObjects(graphs, 'record_shapes', 'recordShapes'),
    ...payloads(input.records, KIND.shape),
  ]
    .map((record, index) => shape(record, index, fieldsByShape))
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
  const shapeById = new Map(shapes.map((entry) => [entry.id, entry]));
  const views = sortDescriptors([
    ...(input.views ?? []),
    ...graphObjects(graphs, 'view_descriptors', 'viewDescriptors'),
    ...payloads(input.records, KIND.view),
  ], 'view');
  const states = sortDescriptors([
    ...(input.states ?? []),
    ...graphObjects(graphs, 'state_descriptors', 'stateDescriptors'),
    ...payloads(input.records, KIND.state),
  ], 'state');
  const actions = sortDescriptors([
    ...(input.actions ?? []),
    ...graphObjects(graphs, 'owner_action_descriptors', 'ownerActionDescriptors'),
    ...payloads(input.records, KIND.action),
  ], 'action');
  const sharePolicies = sortDescriptors([
    ...(input.sharePolicies ?? []),
    ...graphObjects(graphs, 'share_policy_descriptors', 'sharePolicyDescriptors'),
    ...payloads(input.records, KIND.sharePolicy),
  ], 'share-policy');
  const receipts = [
    ...(input.receipts ?? []),
    ...graphObjects(graphs, 'owner_receipts', 'ownerReceipts'),
    ...payloads(input.records, KIND.receipt),
  ].map(receipt);
  const receiptByRef = new Map(receipts.map((entry) => [entry.ref, entry]));
  const actionById = new Map(actions.map((entry) => [entry.id, entry]));
  const records = [
    ...(input.instances ?? []),
    ...graphObjects(graphs, 'record_instances', 'recordInstances'),
    ...payloads(input.records, KIND.instance),
  ].map((record, index) => instance(record, index, shapeById));
  const enrichedShapes = shapes.map((entry) => ({
    ...entry,
    actions: entry.actions.length > 0 ? entry.actions : actions,
    views: entry.views.length > 0 ? entry.views : views,
    sharePolicies: entry.sharePolicies.length > 0 ? entry.sharePolicies : sharePolicies,
  }));
  const selectedShape = enrichedShapes.find((entry) => entry.id === input.selectedShapeId) ?? enrichedShapes[0] ?? null;
  const selectedRecordBase = records.find((entry) => entry.id === input.selectedRecordId) ?? records[0] ?? null;
  const selectedRecord = selectedRecordBase
    ? {
        ...selectedRecordBase,
        linkedReceipts: selectedRecordBase.linkedReceiptRefs
          .map((ref) => receiptByRef.get(ref))
          .filter((entry): entry is RequestIntakeReceipt => !!entry),
        actions: selectedRecordBase.actionDescriptorIds
          .map((id) => actionById.get(id))
          .filter((entry): entry is RequestIntakeDescriptor => !!entry),
      }
    : null;
  const issues = input.issues ?? [];

  return {
    status: deriveStatus(input.status, records, issues),
    shapes: enrichedShapes,
    views,
    states,
    actions,
    receipts,
    records,
    selectedShape,
    selectedRecord,
    issues,
  };
}
