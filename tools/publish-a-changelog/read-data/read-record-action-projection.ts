export type AnyRecord = Record<string, unknown>;

export type ProjectionState = 'empty' | 'sparse' | 'dense' | 'loading' | 'error' | 'blocked';

export interface PublishedRecordRow {
  address?: string;
  payload?: unknown;
}

export interface GenericDescriptor {
  id: string;
  label: string;
  kind?: string;
  order: number;
  path?: string[];
  target?: string;
  method?: string;
  definitionId?: string;
  message?: string;
  selected?: boolean;
  densityThreshold?: number;
  raw?: AnyRecord;
}

export interface GenericWorkRecord {
  id: string;
  title: string;
  groupId?: string;
  resultId?: string;
  fields: AnyRecord;
  relationships: Record<string, string[]>;
  actionIds: string[];
  receiptIds: string[];
  issue?: string;
  raw?: AnyRecord;
}

export interface GenericReceiptRecord {
  id: string;
  label: string;
  recordId?: string;
  actionId?: string;
  target?: string;
  outcome?: string;
  observedAt?: string;
  evidenceRefs: string[];
  raw?: AnyRecord;
}

export interface GenericGroup {
  id: string;
  label: string;
  order: number;
  emptyCopy: string;
  records: GenericWorkRecord[];
}

export interface SelectedGenericRecord extends GenericWorkRecord {
  actions: GenericDescriptor[];
  receipts: GenericReceiptRecord[];
  blockers: GenericDescriptor[];
}

export interface GenericProjectionModel {
  status: ProjectionState;
  copy: Record<string, string>;
  fields: GenericDescriptor[];
  relationships: GenericDescriptor[];
  views: GenericDescriptor[];
  rules: GenericDescriptor[];
  actions: GenericDescriptor[];
  projections: GenericDescriptor[];
  groups: GenericGroup[];
  selectedRecord: SelectedGenericRecord | null;
  receipts: GenericReceiptRecord[];
  diagnostics: {
    descriptorCounts: Record<string, number>;
    missingDescriptorIds: string[];
    stateSource: string;
  };
}

export interface GenericProjectionInput {
  records?: PublishedRecordRow[];
  graph?: AnyRecord;
  recordAtoms?: AnyRecord[];
  receiptAtoms?: AnyRecord[];
  selectedRecordId?: string;
  status?: ProjectionState;
  issues?: string[];
}

const GRAPH_KIND = 'generic.record-action-projection-graph';
const RECORD_KIND = 'generic.record-action-record';
const RECEIPT_KIND = 'generic.receipt-record';

function isObject(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function objectList(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function payloads(rows: PublishedRecordRow[] | undefined, kind: string): AnyRecord[] {
  return (rows ?? [])
    .map((row) => row.payload)
    .filter((payload): payload is AnyRecord => isObject(payload) && payload.kind === kind);
}

function graphPayload(input: GenericProjectionInput): AnyRecord {
  if (isObject(input.graph)) return input.graph;
  return payloads(input.records, GRAPH_KIND)[0] ?? {};
}

function pathFrom(value: unknown): string[] | undefined {
  const path = stringList(value);
  return path.length > 0 ? path : undefined;
}

function descriptor(record: AnyRecord, prefix: string, index: number): GenericDescriptor {
  const id = text(record.id ?? record.ref ?? record.descriptor_id, `${prefix}:${index}`);
  return {
    id,
    label: text(record.label, id),
    kind: text(record.kind, '') || undefined,
    order: number(record.order, index),
    path: pathFrom(record.path ?? record.from_path ?? record.group_path),
    target: text(record.target, '') || undefined,
    method: text(record.method, '') || undefined,
    definitionId: text(record.definition_id ?? record.definitionId, '') || undefined,
    message: text(record.message, '') || undefined,
    selected: record.selected === true,
    densityThreshold: typeof record.density_threshold === 'number' ? record.density_threshold : undefined,
    raw: record,
  };
}

function descriptors(graph: AnyRecord, key: string, prefix: string): GenericDescriptor[] {
  return objectList(graph[key])
    .map((record, index) => descriptor(record, prefix, index))
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function relationships(value: unknown): Record<string, string[]> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, stringList(entry)]),
  );
}

function workRecord(record: AnyRecord, index: number): GenericWorkRecord {
  const id = text(record.id ?? record.record_id ?? record.ref, `record:${index}`);
  const fields = isObject(record.fields)
    ? record.fields
    : isObject(record.field_values)
      ? record.field_values
      : {};
  return {
    id,
    title: text(record.title ?? record.label ?? record.name, id),
    groupId: text(record.group_id ?? record.groupId, '') || undefined,
    resultId: text(record.result_id ?? record.resultId, '') || undefined,
    fields,
    relationships: relationships(record.relationships),
    actionIds: stringList(record.action_ids ?? record.actionIds ?? record.action_descriptor_ids),
    receiptIds: stringList(record.receipt_ids ?? record.receiptIds),
    issue: text(record.issue, '') || undefined,
    raw: record,
  };
}

function receiptRecord(record: AnyRecord, index: number): GenericReceiptRecord {
  const id = text(record.id ?? record.receipt_id ?? record.ref, `receipt:${index}`);
  return {
    id,
    label: text(record.label ?? record.title, id),
    recordId: text(record.record_id ?? record.recordId, '') || undefined,
    actionId: text(record.action_id ?? record.actionId, '') || undefined,
    target: text(record.target, '') || undefined,
    outcome: text(record.outcome ?? record.state, '') || undefined,
    observedAt: text(record.observed_at ?? record.observedAt, '') || undefined,
    evidenceRefs: stringList(record.evidence_refs ?? record.evidenceRefs),
    raw: record,
  };
}

function copy(graph: AnyRecord): Record<string, string> {
  const surfaceCopy = isObject(graph.surface_copy) ? graph.surface_copy : {};
  return Object.fromEntries(
    Object.entries(surfaceCopy).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function selectedViewStatus(
  input: GenericProjectionInput,
  graph: AnyRecord,
  records: GenericWorkRecord[],
): { status: ProjectionState; source: string } {
  if (input.status) return { status: input.status, source: 'input.status' };
  const graphState = text(graph.state, '') as ProjectionState;
  if (graphState) return { status: graphState, source: 'graph.state' };
  if ((input.issues ?? []).length > 0) return { status: 'error', source: 'input.issues' };
  if (records.some((record) => record.issue)) return { status: 'blocked', source: 'record.issue' };
  if (records.length === 0) return { status: 'empty', source: 'record-count' };
  const view = descriptors(graph, 'views', 'view').find((entry) => entry.selected) ?? descriptors(graph, 'views', 'view')[0];
  if (view?.densityThreshold !== undefined && records.length >= view.densityThreshold) {
    return { status: 'dense', source: 'view.density_threshold' };
  }
  return { status: 'sparse', source: 'record-count' };
}

function recordHasRuleRequirement(record: GenericWorkRecord, rule: GenericDescriptor): boolean {
  const raw = rule.raw ?? {};
  const requiredRelationship = text(raw.requires_relationship, '');
  if (requiredRelationship) {
    const key = requiredRelationship.split(':').at(-1) ?? requiredRelationship;
    return (record.relationships[key] ?? record.relationships[requiredRelationship] ?? []).length > 0;
  }
  const requiredField = pathFrom(raw.requires_field);
  if (requiredField) {
    let current: unknown = record;
    for (const segment of requiredField) current = isObject(current) ? current[segment] : undefined;
    return current !== undefined && current !== false && current !== '';
  }
  return true;
}

function blockedRules(record: GenericWorkRecord, rules: GenericDescriptor[]): GenericDescriptor[] {
  return rules.filter((rule) => !recordHasRuleRequirement(record, rule));
}

export function readRecordActionProjection(input: GenericProjectionInput): GenericProjectionModel {
  const graph = graphPayload(input);
  const records = [
    ...objectList(graph.records),
    ...(input.recordAtoms ?? []),
    ...payloads(input.records, RECORD_KIND),
  ].map(workRecord);
  const receipts = [
    ...objectList(graph.receipts),
    ...(input.receiptAtoms ?? []),
    ...payloads(input.records, RECEIPT_KIND),
  ].map(receiptRecord);
  const fields = descriptors(graph, 'fields', 'field');
  const relationshipDescriptors = descriptors(graph, 'relationships', 'relationship');
  const views = descriptors(graph, 'views', 'view');
  const rules = descriptors(graph, 'rules', 'rule');
  const actions = descriptors(graph, 'actions', 'action');
  const projectionDescriptors = descriptors(graph, 'projections', 'projection');
  const groupDescriptors = descriptors(graph, 'groups', 'group');

  const groups = groupDescriptors.map((group) => ({
    id: group.id,
    label: group.label,
    order: group.order,
    emptyCopy: text(group.raw?.empty_copy ?? group.raw?.emptyCopy, ''),
    records: records.filter((record) => record.groupId === group.id),
  }));
  const missingGroupRecords = records.filter((record) => record.groupId && !groupDescriptors.some((group) => group.id === record.groupId));
  if (missingGroupRecords.length > 0) {
    groups.push({
      id: 'group:unresolved',
      label: 'Unresolved',
      order: Number.MAX_SAFE_INTEGER,
      emptyCopy: '',
      records: missingGroupRecords,
    });
  }

  const selectedRecord =
    records.find((record) => record.id === input.selectedRecordId)
    ?? records[0]
    ?? null;
  const selected = selectedRecord
    ? {
        ...selectedRecord,
        actions: selectedRecord.actionIds.length > 0
          ? actions.filter((action) => selectedRecord.actionIds.includes(action.id))
          : actions,
        receipts: receipts.filter((receipt) => receipt.recordId === selectedRecord.id || selectedRecord.receiptIds.includes(receipt.id)),
        blockers: blockedRules(selectedRecord, rules),
      }
    : null;
  const state = selectedViewStatus(input, graph, records);

  return {
    status: state.status,
    copy: copy(graph),
    fields,
    relationships: relationshipDescriptors,
    views,
    rules,
    actions,
    projections: projectionDescriptors,
    groups,
    selectedRecord: selected,
    receipts,
    diagnostics: {
      descriptorCounts: {
        fields: fields.length,
        relationships: relationshipDescriptors.length,
        views: views.length,
        rules: rules.length,
        actions: actions.length,
        projections: projectionDescriptors.length,
        groups: groups.length,
        records: records.length,
        receipts: receipts.length,
      },
      missingDescriptorIds: [
        ...missingGroupRecords.map((record) => record.groupId ?? ''),
        ...(selectedRecord?.actionIds ?? []).filter((id) => !actions.some((action) => action.id === id)),
      ].filter(Boolean),
      stateSource: state.source,
    },
  };
}

