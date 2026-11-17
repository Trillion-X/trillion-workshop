// package-set://bitfield-studio/packages/codes-and-rewards/read-data/read-record-interaction-surface.ts
//
// Generic descriptor projection for CS-048. Package words live in contract
// data; this module follows record, field, view, action, and evidence
// descriptors without branching on package labels.

import defaultContract from '../record-interaction-contract.json';

export type JsonRecord = Record<string, unknown>;

export interface FieldDescriptor {
  id: string;
  label: string;
  paths: readonly (readonly string[])[];
  format?: { kind?: string; empty?: string };
}

export interface RecordTypeDescriptor {
  id: string;
  label: string;
  source_role: string;
  title_field?: string;
}

export interface ProjectionViewDescriptor {
  id: string;
  label: string;
  record_sources?: readonly { role: string }[];
  columns?: readonly string[];
  summary_sources?: readonly { role: string; label_field: string; value_field: string }[];
  actions?: readonly string[];
  empty?: { title?: string; detail?: string };
}

export interface ActionDescriptor {
  id: string;
  label: string;
  owner_invoke?: JsonRecord;
  input_bindings?: readonly JsonRecord[];
  local_acknowledgement?: boolean;
  relationship_refs?: readonly string[];
  evidence_ref?: string;
  projection_ref?: string;
  payload_template?: JsonRecord;
  metadata?: JsonRecord;
}

export interface RuleDescriptor {
  id: string;
  severity?: string;
  message: string;
  when?: JsonRecord;
}

export interface RecordInteractionContract {
  kind: string;
  package: string;
  record_types?: readonly RecordTypeDescriptor[];
  field_descriptors?: readonly FieldDescriptor[];
  projection_views?: readonly ProjectionViewDescriptor[];
  rule_descriptors?: readonly RuleDescriptor[];
  action_descriptors?: readonly ActionDescriptor[];
  owner_evidence_refs?: readonly JsonRecord[];
  human_translation_records?: readonly JsonRecord[];
  proof_descriptors?: readonly JsonRecord[];
}

export interface SourceRecord {
  id: string;
  role?: string;
  address?: string;
  payload: JsonRecord;
  ownerEvidenceRefs: readonly string[];
}

export interface ProjectedField {
  fieldId: string;
  label: string;
  value: unknown;
  text: string;
}

export interface ProjectedRecord {
  id: string;
  role?: string;
  address?: string;
  title: string;
  fields: readonly ProjectedField[];
  ownerEvidenceRefs: readonly string[];
  source: JsonRecord;
}

export interface ProjectedSummary {
  id: string;
  label: string;
  value: unknown;
  text: string;
}

export interface ProjectedAction {
  id: string;
  label: string;
  enabled: boolean;
  disabledReason?: string;
}

export interface ProjectionProblem {
  id: string;
  severity: string;
  message: string;
}

export interface RecordInteractionSurface {
  packageId: string;
  view: { id: string; label: string };
  records: readonly ProjectedRecord[];
  summaries: readonly ProjectedSummary[];
  actions: readonly ProjectedAction[];
  problems: readonly ProjectionProblem[];
  empty: { title: string; detail: string };
  proof: {
    descriptorCounts: {
      recordTypes: number;
      fields: number;
      views: number;
      actions: number;
    };
    sourceRecordCount: number;
  };
}

export interface ReadRecordInteractionSurfaceInput {
  rows?: unknown;
  contract?: RecordInteractionContract;
  view_id?: string;
  disabled_actions?: Record<string, string>;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
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

function formatValue(value: unknown, field?: FieldDescriptor): string {
  if (value === undefined || value === null || value === '') return field?.format?.empty ?? '';
  if (Array.isArray(value)) return value.map((entry) => formatValue(entry)).filter(Boolean).join(', ');
  if (isRecord(value)) return JSON.stringify(value);
  return String(value);
}

function normalizeContract(value: unknown): RecordInteractionContract {
  const contract = isRecord(value) ? value as unknown as RecordInteractionContract : defaultContract as RecordInteractionContract;
  return {
    ...contract,
    record_types: list(contract.record_types) as RecordTypeDescriptor[],
    field_descriptors: list(contract.field_descriptors) as FieldDescriptor[],
    projection_views: list(contract.projection_views) as ProjectionViewDescriptor[],
    rule_descriptors: list(contract.rule_descriptors) as RuleDescriptor[],
    action_descriptors: list(contract.action_descriptors) as ActionDescriptor[],
  };
}

function rowPayload(row: unknown): JsonRecord | null {
  if (!isRecord(row)) return null;
  if (isRecord(row.payload)) return row.payload;
  return row;
}

function sourceRecords(rows: unknown): SourceRecord[] {
  return list(rows).flatMap((row, index): SourceRecord[] => {
    const payload = rowPayload(row);
    if (!payload) return [];
    const envelope = isRecord(row) ? row : {};
    return [{
      id: text(envelope.id) || text(payload.id) || text(envelope.address) || `record:${index}`,
      role: text(envelope.role) || text(payload.role) || undefined,
      address: text(envelope.address) || undefined,
      payload,
      ownerEvidenceRefs: list(envelope.owner_evidence_refs ?? payload.owner_evidence_refs)
        .map(text)
        .filter(Boolean),
    }];
  });
}

function fieldById(fields: readonly FieldDescriptor[], id?: string): FieldDescriptor | undefined {
  return id ? fields.find((field) => field.id === id) : undefined;
}

function valueFor(record: SourceRecord, field: FieldDescriptor): ProjectedField {
  for (const path of field.paths) {
    const value = readPath(record.payload, path);
    if (value !== undefined && value !== null && value !== '') {
      return { fieldId: field.id, label: field.label, value, text: formatValue(value, field) };
    }
  }
  return { fieldId: field.id, label: field.label, value: undefined, text: formatValue(undefined, field) };
}

function viewRecords(records: readonly SourceRecord[], view: ProjectionViewDescriptor): SourceRecord[] {
  const roles = new Set(list(view.record_sources).map((source) => isRecord(source) ? text(source.role) : '').filter(Boolean));
  return roles.size === 0 ? [...records] : records.filter((record) => record.role && roles.has(record.role));
}

function projectRecord(record: SourceRecord, fields: readonly FieldDescriptor[], view: ProjectionViewDescriptor): ProjectedRecord {
  const columns = list(view.columns).map(text).filter(Boolean);
  const selectedFields = columns.length > 0
    ? columns.map((id) => fieldById(fields, id)).filter((field): field is FieldDescriptor => !!field)
    : fields;
  const projectedFields = selectedFields.map((field) => valueFor(record, field));
  const title = projectedFields.find((field) => field.text)?.text || record.id;
  return {
    id: record.id,
    role: record.role,
    address: record.address,
    title,
    fields: projectedFields,
    ownerEvidenceRefs: record.ownerEvidenceRefs,
    source: record.payload,
  };
}

function projectSummaries(records: readonly SourceRecord[], fields: readonly FieldDescriptor[], view: ProjectionViewDescriptor): ProjectedSummary[] {
  return list(view.summary_sources).flatMap((source, index): ProjectedSummary[] => {
    if (!isRecord(source)) return [];
    const role = text(source.role);
    const labelField = fieldById(fields, text(source.label_field));
    const valueField = fieldById(fields, text(source.value_field));
    if (!role || !labelField || !valueField) return [];
    return records.filter((record) => record.role === role).map((record) => {
      const label = valueFor(record, labelField);
      const value = valueFor(record, valueField);
      return {
        id: `${role}:${record.id}:${index}`,
        label: label.text || labelField.label,
        value: value.value,
        text: value.text,
      };
    });
  });
}

function projectActions(contract: RecordInteractionContract, view: ProjectionViewDescriptor, disabled: Record<string, string> | undefined): ProjectedAction[] {
  const actionIds = new Set(list(view.actions).map(text).filter(Boolean));
  return (contract.action_descriptors ?? [])
    .filter((action) => actionIds.size === 0 || actionIds.has(action.id))
    .map((action) => {
      const disabledReason = disabled?.[action.id];
      return {
        id: action.id,
        label: action.label,
        enabled: !disabledReason,
        ...(disabledReason ? { disabledReason } : {}),
      };
    });
}

function problemsFor(view: ProjectionViewDescriptor, records: readonly ProjectedRecord[], contract: RecordInteractionContract): ProjectionProblem[] {
  return (contract.rule_descriptors ?? []).flatMap((rule): ProjectionProblem[] => {
    if (rule.when?.missing_view_records === true && records.length === 0) {
      return [{ id: rule.id, severity: rule.severity ?? 'attention', message: rule.message }];
    }
    return [];
  });
}

export function readRecordInteractionSurface(input: ReadRecordInteractionSurfaceInput = {}): RecordInteractionSurface {
  const contract = normalizeContract(input.contract);
  const views = contract.projection_views ?? [];
  const view = views.find((candidate) => candidate.id === input.view_id) ?? views[0] ?? {
    id: 'default',
    label: contract.package,
  };
  const rows = sourceRecords(input.rows);
  const fields = contract.field_descriptors ?? [];
  const projectedRecords = viewRecords(rows, view).map((record) => projectRecord(record, fields, view));

  return {
    packageId: contract.package,
    view: { id: view.id, label: view.label },
    records: projectedRecords,
    summaries: projectSummaries(rows, fields, view),
    actions: projectActions(contract, view, input.disabled_actions),
    problems: problemsFor(view, projectedRecords, contract),
    empty: {
      title: view.empty?.title ?? '',
      detail: view.empty?.detail ?? '',
    },
    proof: {
      descriptorCounts: {
        recordTypes: contract.record_types?.length ?? 0,
        fields: fields.length,
        views: views.length,
        actions: contract.action_descriptors?.length ?? 0,
      },
      sourceRecordCount: rows.length,
    },
  };
}
