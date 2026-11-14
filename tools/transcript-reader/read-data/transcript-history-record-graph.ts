// package-set://bitfield-studio/packages/transcript-history/read-data/transcript-history-record-graph.ts
//
// Package-owned translator from generic graph descriptors + projection rows to
// a serializable review model. Shared code stays blind; package vocabulary is
// supplied as descriptor data.

export type JsonRecord = Record<string, unknown>;

export interface TranscriptHistoryProjectionRow {
  address?: string;
  role?: string;
  payload?: unknown;
  source_package?: string;
  blocker?: TranscriptHistoryBlocker;
}

export interface TranscriptHistoryBlocker {
  code?: string;
  message?: string;
  severity?: string;
  proof_gate?: string;
}

export interface GraphFieldDescriptor {
  id: string;
  label: string;
  role?: string;
  paths: readonly (readonly string[])[];
  format?: {
    kind?: string;
    empty?: string;
    maximumFractionDigits?: number;
    minimumFractionDigits?: number;
  };
}

export interface GraphViewDescriptor {
  id: string;
  label: string;
  eyebrow?: string;
  sourceRole: string;
  status?: {
    empty?: string;
    waiting?: string;
    ready?: string;
    blocked?: string;
  };
  primary?: {
    valueField?: string;
    labelField?: string;
    detailFields?: readonly string[];
    emptyValue?: string;
    emptyLabel?: string;
  };
  item?: {
    titleField?: string;
    detailFields?: readonly string[];
    badgeField?: string;
    maxItems?: number;
  };
  detail?: {
    fields?: readonly string[];
  };
}

export interface GraphActionDescriptor {
  id: string;
  label: string;
  operation?: string;
  target?: string;
  proofGates?: readonly string[];
  disabledWhen?: {
    selectedHasField?: string;
    missingProof?: boolean;
  };
}

export interface GraphDescriptorSet {
  fields?: readonly GraphFieldDescriptor[];
  views?: readonly GraphViewDescriptor[];
  actions?: readonly GraphActionDescriptor[];
  records?: readonly JsonRecord[];
  relationships?: readonly JsonRecord[];
  rules?: readonly JsonRecord[];
  projections?: readonly JsonRecord[];
  ownerRefs?: readonly JsonRecord[];
  targetInvocations?: readonly JsonRecord[];
}

export interface ReadTranscriptHistoryGraphInput {
  rows?: unknown;
  descriptors?: GraphDescriptorSet;
}

export interface TranscriptHistoryValue {
  fieldId: string;
  label: string;
  value: unknown;
  text: string;
}

export interface TranscriptHistoryItem {
  id: string;
  title: string;
  detail: string;
  badge?: string;
  values: readonly TranscriptHistoryValue[];
  raw: JsonRecord;
  proofRefs: readonly string[];
}

export interface TranscriptHistoryModelAction {
  id: string;
  label: string;
  target: string;
  operation: string;
  blocked: boolean;
  blockedReason?: string;
  proofGates: readonly string[];
}

export interface TranscriptHistoryModel {
  state: { key: string; label: string };
  status: string;
  statusTone: 'muted' | 'info' | 'success' | 'warning';
  eyebrow: string;
  title: string;
  primary: {
    value: string;
    label: string;
    detail?: string;
  };
  itemsTitle: string;
  items: readonly TranscriptHistoryItem[];
  empty: {
    title: string;
    detail: string;
  };
  detailsTitle: string;
  details: readonly TranscriptHistoryValue[];
  blockers: readonly TranscriptHistoryBlocker[];
  actions: readonly TranscriptHistoryModelAction[];
  proof: {
    descriptorCount: number;
    sourceRecordCount: number;
    sourceProjectionLabels: readonly string[];
  };
  revision: string;
}

const GRAPH_DESCRIPTOR_KINDS = new Set([
  'current-record-action-graph.descriptors',
  'current-record-action-graph.record-descriptors',
  'current-record-action-graph.field-descriptors',
  'current-record-action-graph.view-descriptors',
  'current-record-action-graph.action-descriptors',
  'current-record-action-graph.relationship-descriptors',
  'current-record-action-graph.rule-descriptors',
  'current-record-action-graph.projection-descriptors',
  'current-record-action-graph.owner-references',
  'current-record-action-graph.target-invocations',
]);

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rowsFrom(raw: unknown): TranscriptHistoryProjectionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is TranscriptHistoryProjectionRow => isRecord(row));
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function readField(record: unknown, field?: GraphFieldDescriptor): unknown {
  if (!field) return undefined;
  for (const path of field.paths) {
    const value = readPath(record, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function formatValue(value: unknown, field?: GraphFieldDescriptor): string {
  if (value === undefined || value === null || value === '') return field?.format?.empty ?? '';
  if (field?.format?.kind === 'datetime' && typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  if (field?.format?.kind === 'durationSeconds' && typeof value === 'number' && Number.isFinite(value)) {
    const minutes = Math.floor(value / 60);
    const rest = Math.floor(value % 60);
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const minuteRest = minutes % 60;
      return minuteRest ? `${hours}h ${minuteRest}m` : `${hours}h`;
    }
    return `${minutes}:${String(rest).padStart(2, '0')}`;
  }
  if (field?.format?.kind === 'percent' && typeof value === 'number' && Number.isFinite(value)) {
    return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
  }
  if (field?.format?.kind === 'number' && typeof value === 'number' && Number.isFinite(value)) {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: field.format.maximumFractionDigits ?? 0,
      minimumFractionDigits: field.format.minimumFractionDigits,
    }).format(value);
  }
  if (Array.isArray(value)) return value.map((entry) => formatValue(entry)).filter(Boolean).join(', ');
  if (isRecord(value)) return JSON.stringify(value);
  return String(value);
}

function fieldById(fields: readonly GraphFieldDescriptor[], id?: string): GraphFieldDescriptor | undefined {
  return id ? fields.find((field) => field.id === id) : undefined;
}

function descriptorPayloads(rows: readonly TranscriptHistoryProjectionRow[]): GraphDescriptorSet {
  const descriptors: GraphDescriptorSet = {};
  for (const row of rows) {
    if (!isRecord(row.payload) || typeof row.payload.kind !== 'string' || !GRAPH_DESCRIPTOR_KINDS.has(row.payload.kind)) continue;
    if (Array.isArray(row.payload.fields)) descriptors.fields = row.payload.fields as GraphFieldDescriptor[];
    if (Array.isArray(row.payload.views)) descriptors.views = row.payload.views as GraphViewDescriptor[];
    if (Array.isArray(row.payload.actions)) descriptors.actions = row.payload.actions as GraphActionDescriptor[];
    if (Array.isArray(row.payload.records)) descriptors.records = row.payload.records;
    if (Array.isArray(row.payload.relationships)) descriptors.relationships = row.payload.relationships;
    if (Array.isArray(row.payload.rules)) descriptors.rules = row.payload.rules;
    if (Array.isArray(row.payload.projections)) descriptors.projections = row.payload.projections;
    if (Array.isArray(row.payload.owner_refs)) descriptors.ownerRefs = row.payload.owner_refs;
    if (Array.isArray(row.payload.target_invocations)) descriptors.targetInvocations = row.payload.target_invocations;
  }
  return descriptors;
}

function mergeDescriptors(
  supplied: GraphDescriptorSet | undefined,
  fromRows: GraphDescriptorSet,
): Required<GraphDescriptorSet> {
  return {
    fields: supplied?.fields ?? fromRows.fields ?? [],
    views: supplied?.views ?? fromRows.views ?? [],
    actions: supplied?.actions ?? fromRows.actions ?? [],
    records: supplied?.records ?? fromRows.records ?? [],
    relationships: supplied?.relationships ?? fromRows.relationships ?? [],
    rules: supplied?.rules ?? fromRows.rules ?? [],
    projections: supplied?.projections ?? fromRows.projections ?? [],
    ownerRefs: supplied?.ownerRefs ?? fromRows.ownerRefs ?? [],
    targetInvocations: supplied?.targetInvocations ?? fromRows.targetInvocations ?? [],
  };
}

function rowsByRole(rows: readonly TranscriptHistoryProjectionRow[]): Record<string, JsonRecord[]> {
  const grouped: Record<string, JsonRecord[]> = {};
  for (const row of rows) {
    if (typeof row.role !== 'string' || !isRecord(row.payload)) continue;
    grouped[row.role] = [...(grouped[row.role] ?? []), row.payload];
  }
  return grouped;
}

function blockersFrom(rows: readonly TranscriptHistoryProjectionRow[], descriptors: Required<GraphDescriptorSet>): TranscriptHistoryBlocker[] {
  const blockers = rows.flatMap((row) => row.blocker ? [row.blocker] : []);
  for (const rule of descriptors.rules) {
    const when = isRecord(rule.when) ? rule.when : {};
    const missingDescriptor = text(when.missing_descriptor);
    if (missingDescriptor && descriptorCount(descriptors) === 0) {
      blockers.push({ code: text(rule.id, 'descriptor-missing'), message: text(rule.message, 'This page is missing its material setup.'), severity: text(rule.severity, 'blocked') });
    }
  }
  return blockers;
}

function descriptorCount(descriptors: Required<GraphDescriptorSet>): number {
  return descriptors.fields.length
    + descriptors.views.length
    + descriptors.actions.length
    + descriptors.records.length
    + descriptors.relationships.length
    + descriptors.rules.length
    + descriptors.projections.length
    + descriptors.ownerRefs.length
    + descriptors.targetInvocations.length;
}

function valueFor(record: unknown, field: GraphFieldDescriptor): TranscriptHistoryValue {
  const value = readField(record, field);
  return {
    fieldId: field.id,
    label: field.label,
    value,
    text: formatValue(value, field),
  };
}

function itemId(record: JsonRecord, index: number): string {
  for (const key of ['id', 'record_id', 'entry_id', 'address']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return `item:${index}`;
}

function proofRefs(record: JsonRecord): string[] {
  const refs = records(record.proof_refs).map((ref) => text(ref.ref ?? ref.address)).filter(Boolean);
  for (const key of ['source_fingerprint', 'transcript_result_id']) {
    const value = record[key];
    if (typeof value === 'string' && value) refs.push(value);
  }
  return [...new Set(refs)];
}

function itemFor(record: JsonRecord, index: number, fields: readonly GraphFieldDescriptor[], view: GraphViewDescriptor): TranscriptHistoryItem {
  const titleField = fieldById(fields, view.item?.titleField);
  const badgeField = fieldById(fields, view.item?.badgeField);
  const detailFields = (view.item?.detailFields ?? [])
    .map((id) => fieldById(fields, id))
    .filter((field): field is GraphFieldDescriptor => Boolean(field));
  const detailValues = detailFields.map((field) => valueFor(record, field)).filter((value) => value.text);
  const titleValue = formatValue(readField(record, titleField), titleField);
  const badge = formatValue(readField(record, badgeField), badgeField);
  return {
    id: itemId(record, index),
    title: titleValue || `Record ${index + 1}`,
    detail: detailValues.map((value) => `${value.label}: ${value.text}`).join(' · '),
    ...(badge ? { badge } : {}),
    values: fields.map((field) => valueFor(record, field)).filter((value) => value.text),
    raw: record,
    proofRefs: proofRefs(record),
  };
}

function actionFor(action: GraphActionDescriptor, selected: TranscriptHistoryItem | null, blockers: readonly TranscriptHistoryBlocker[]): TranscriptHistoryModelAction {
  const missingSelectedField = action.disabledWhen?.selectedHasField && selected
    ? !text(readPath(selected.raw, [action.disabledWhen.selectedHasField]))
    : false;
  const missingSelected = !selected;
  const missingProof = Boolean(action.disabledWhen?.missingProof) && (selected?.proofRefs.length ?? 0) === 0;
  const blockedByRule = missingSelected || missingSelectedField || missingProof || blockers.some((blocker) => blocker.severity === 'blocked');
  return {
    id: action.id,
    label: action.label,
    target: action.target ?? 'slot::workflow',
    operation: action.operation ?? 'engine.operation.write-batch',
    blocked: blockedByRule,
    blockedReason: blockedByRule
      ? blockers.find((blocker) => blocker.severity === 'blocked')?.message ?? 'Select a record with current proof before running this action.'
      : undefined,
    proofGates: action.proofGates ?? [],
  };
}

export function readTranscriptHistoryRecordGraph(input: ReadTranscriptHistoryGraphInput): TranscriptHistoryModel {
  const rows = rowsFrom(input.rows);
  const descriptors = mergeDescriptors(input.descriptors, descriptorPayloads(rows));
  const blockerList = blockersFrom(rows, descriptors);
  const byRole = rowsByRole(rows);
  const view = descriptors.views[0];
  const sourceRows = view ? byRole[view.sourceRole] ?? [] : [];
  const fields = descriptors.fields;
  const items = view
    ? sourceRows.slice(0, view.item?.maxItems ?? sourceRows.length).map((row, index) => itemFor(row, index, fields, view))
    : [];
  const selected = items[0] ?? null;
  const details = view?.detail?.fields
    ? view.detail.fields
      .map((id) => fieldById(fields, id))
      .filter((field): field is GraphFieldDescriptor => Boolean(field))
      .flatMap((field) => selected ? [valueFor(selected.raw, field)] : [])
      .filter((value) => value.text)
    : [];
  const blocked = blockerList.some((blocker) => blocker.severity === 'blocked');
  const status = blocked ? view?.status?.blocked : items.length ? view?.status?.ready : rows.length ? view?.status?.waiting : view?.status?.empty;
  const statusTone = blocked ? 'warning' : items.length ? 'success' : rows.length ? 'info' : 'muted';
  const primaryValueField = fieldById(fields, view?.primary?.valueField);
  const primaryLabelField = fieldById(fields, view?.primary?.labelField);
  const primaryValue = selected ? formatValue(readField(selected.raw, primaryValueField), primaryValueField) : '';
  const primaryLabel = selected ? formatValue(readField(selected.raw, primaryLabelField), primaryLabelField) : '';
  const primaryDetail = selected && view?.primary?.detailFields
    ? view.primary.detailFields
      .map((id) => fieldById(fields, id))
      .filter((field): field is GraphFieldDescriptor => Boolean(field))
      .map((field) => formatValue(readField(selected.raw, field), field))
      .filter(Boolean)
      .join(' · ')
    : undefined;

  return {
    state: { key: blocked ? 'blocked' : items.length ? 'ready' : rows.length ? 'waiting' : 'empty', label: status ?? 'Waiting' },
    status: status ?? 'Waiting',
    statusTone,
    eyebrow: view?.eyebrow ?? '',
    title: view?.label ?? 'Past transcripts',
    primary: {
      value: primaryValue || view?.primary?.emptyValue || (items.length ? String(items.length) : 'No records'),
      label: primaryLabel || view?.primary?.emptyLabel || 'Waiting for material.',
      ...(primaryDetail ? { detail: primaryDetail } : {}),
    },
    itemsTitle: view?.label ?? 'Records',
    items,
    empty: {
      title: view?.status?.empty ?? 'No records yet',
      detail: 'When owner actions write current records, they appear here.',
    },
    detailsTitle: 'Details',
    details,
    blockers: blockerList,
    actions: descriptors.actions.map((action) => actionFor(action, selected, blockerList)),
    proof: {
      descriptorCount: descriptorCount(descriptors),
      sourceRecordCount: sourceRows.length,
      sourceProjectionLabels: descriptors.projections.map((projection) => text(projection.label ?? projection.id)).filter(Boolean),
    },
    revision: `${descriptorCount(descriptors)}:${rows.length}:${items.length}:${blockerList.length}`,
  };
}
