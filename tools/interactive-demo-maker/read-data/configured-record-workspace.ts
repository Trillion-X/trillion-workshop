import descriptorKinds from './descriptor-kinds.json' with { type: 'json' };

export type JsonRecord = Record<string, unknown>;

export interface AddressedRecordRow {
  address?: string;
  payload?: unknown;
}

export interface FieldDescriptor {
  id: string;
  label: string;
  role?: string;
  value_kind?: string;
  paths?: readonly (readonly string[])[];
}

export interface RelationshipDescriptor {
  id: string;
  label: string;
  role?: string;
  from_role?: string;
  to_role?: string;
  order_key?: string;
}

export interface ViewDescriptor {
  id: string;
  label: string;
  empty?: {
    title?: string;
    actions?: readonly string[];
  };
  dense_at?: number;
  sections?: readonly { id: string; label: string }[];
}

export interface ActionDescriptor {
  id: string;
  label: string;
  operation?: string;
  target?: string;
  definition_id?: string;
  display_role?: string;
  input?: JsonRecord;
  copy?: readonly ActionInputCopy[];
}

export interface ActionInputCopy {
  key: string;
  from?: readonly string[];
  value?: unknown;
}

export interface RuleDescriptor {
  id: string;
  label: string;
  severity?: string;
  when?: JsonRecord;
}

export interface DescriptorSet {
  fields?: readonly FieldDescriptor[];
  relationships?: readonly RelationshipDescriptor[];
  views?: readonly ViewDescriptor[];
  actions?: readonly ActionDescriptor[];
  rules?: readonly RuleDescriptor[];
}

export interface SourceMaterial {
  ref: string;
  label: string;
  owner_ref?: string;
  kind?: string;
  raw?: unknown;
}

export interface WorkspaceRecord {
  ref: string;
  label: string;
  role?: string;
  order: number;
  field_values: JsonRecord;
  relationships: readonly WorkspaceRelationship[];
  source_refs: readonly string[];
  issue_refs: readonly string[];
  raw?: unknown;
}

export interface WorkspaceRelationship {
  role: string;
  to_ref: string;
  order?: number;
}

export interface WorkspaceAction {
  id: string;
  label: string;
  operation: string;
  target: string;
  definition_id?: string;
  display_role?: string;
  input: JsonRecord;
  blocked: boolean;
  blocked_reason?: string;
}

export interface WorkspaceProposal {
  ref: string;
  record_ref: string;
  field_values: JsonRecord;
  relationships: readonly WorkspaceRelationship[];
  source_refs: readonly string[];
  confidence?: number;
  rule_ref?: string;
  profile_ref?: string;
}

export interface StructuredProposalRow {
  ref?: string;
  record_ref?: string;
  field_values?: unknown;
  relationships?: unknown;
  source_refs?: unknown;
  confidence?: unknown;
  rule_ref?: unknown;
  profile_ref?: unknown;
}

export interface ConfiguredRecordWorkspaceInput {
  rows?: readonly AddressedRecordRow[];
  records?: readonly unknown[];
  source_material?: readonly unknown[];
  proposals?: readonly unknown[];
  descriptors?: DescriptorSet;
  selected_ref?: string;
  state?: string;
  process_state?: string;
  issues?: readonly string[];
  reader_key?: string;
}

export interface ConfiguredRecordWorkspaceModel {
  state: string;
  reader_key: string;
  view: ViewDescriptor;
  sections: readonly { id: string; label: string }[];
  empty: {
    title: string;
    actions: readonly string[];
  };
  sources: readonly SourceMaterial[];
  records: readonly WorkspaceRecord[];
  selected: WorkspaceRecord | null;
  proposals: readonly WorkspaceProposal[];
  actions: readonly WorkspaceAction[];
  rules: readonly RuleDescriptor[];
  issues: readonly string[];
  proof: {
    descriptor_counts: Record<string, number>;
    source_record_count: number;
    proposal_count: number;
    selected_ref: string | null;
  };
}

// DATA: which descriptor row kind fills which DescriptorSet key, and the payload array that holds it.
const DESCRIPTOR_KINDS = descriptorKinds.kinds as Record<string, { set: keyof DescriptorSet; list: string }>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function objectList(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function payloads(rows: readonly AddressedRecordRow[] | undefined): JsonRecord[] {
  return (rows ?? []).map((row) => row.payload).filter(isRecord);
}

export function descriptorSetFromRows(rows: readonly AddressedRecordRow[] | undefined): DescriptorSet {
  const descriptors: Record<string, unknown> = {};
  for (const payload of payloads(rows)) {
    const kind = text(payload.kind);
    if (!Object.hasOwn(DESCRIPTOR_KINDS, kind)) continue;
    const spec = DESCRIPTOR_KINDS[kind];
    descriptors[spec.set] = objectList(payload[spec.list]);
  }
  return descriptors as DescriptorSet;
}

function mergeDescriptors(input: ConfiguredRecordWorkspaceInput): Required<DescriptorSet> {
  const rowDescriptors = descriptorSetFromRows(input.rows);
  return {
    fields: input.descriptors?.fields ?? rowDescriptors.fields ?? [],
    relationships: input.descriptors?.relationships ?? rowDescriptors.relationships ?? [],
    views: input.descriptors?.views ?? rowDescriptors.views ?? [],
    actions: input.descriptors?.actions ?? rowDescriptors.actions ?? [],
    rules: input.descriptors?.rules ?? rowDescriptors.rules ?? [],
  };
}

function fieldValue(record: JsonRecord, field: FieldDescriptor): unknown {
  for (const path of field.paths ?? []) {
    const value = readPath(record, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function relationship(value: unknown): WorkspaceRelationship | null {
  if (!isRecord(value)) return null;
  const role = text(value.role);
  const to_ref = text(value.to_ref ?? value.toRef ?? value.ref);
  if (!role || !to_ref) return null;
  return {
    role,
    to_ref,
    order: typeof value.order === 'number' ? value.order : undefined,
  };
}

function workspaceRecord(value: unknown, fields: readonly FieldDescriptor[], index: number): WorkspaceRecord | null {
  if (!isRecord(value)) return null;
  const ref = text(value.ref ?? value.id ?? value.address, `record:${index}`);
  const suppliedFields = isRecord(value.field_values) ? value.field_values : {};
  const field_values = fields.reduce<JsonRecord>((next, field) => {
    const valueAtPath = fieldValue(value, field);
    return valueAtPath === undefined ? next : { ...next, [field.id]: valueAtPath };
  }, suppliedFields);
  return {
    ref,
    label: text(value.label ?? value.title ?? field_values.title, ref),
    role: text(value.role, '') || undefined,
    order: numberValue(value.order ?? value.position, index),
    field_values,
    relationships: objectList(value.relationships).map(relationship).filter((entry): entry is WorkspaceRelationship => !!entry),
    source_refs: stringList(value.source_refs ?? value.sourceRefs),
    issue_refs: stringList(value.issue_refs ?? value.issueRefs),
    raw: value,
  };
}

function sourceMaterial(value: unknown, index: number): SourceMaterial | null {
  if (!isRecord(value)) return null;
  const ref = text(value.ref ?? value.address ?? value.id, `source:${index}`);
  return {
    ref,
    label: text(value.label ?? value.title, ref),
    owner_ref: text(value.owner_ref ?? value.ownerRef, '') || undefined,
    kind: text(value.kind, '') || undefined,
    raw: value,
  };
}

export function materializeStructuredProposalRows(rows: readonly unknown[]): WorkspaceProposal[] {
  return rows.flatMap((row, index) => {
    if (!isRecord(row)) return [];
    const record_ref = text(row.record_ref ?? row.recordRef);
    if (!record_ref) return [];
    const ref = text(row.ref, `proposal:${record_ref}:${index}`);
    return [{
      ref,
      record_ref,
      field_values: isRecord(row.field_values) ? row.field_values : {},
      relationships: objectList(row.relationships).map(relationship).filter((entry): entry is WorkspaceRelationship => !!entry),
      source_refs: stringList(row.source_refs ?? row.sourceRefs),
      confidence: typeof row.confidence === 'number' ? row.confidence : undefined,
      rule_ref: text(row.rule_ref ?? row.ruleRef, '') || undefined,
      profile_ref: text(row.profile_ref ?? row.profileRef, '') || undefined,
    }];
  });
}

function actionBlocked(action: ActionDescriptor, records: readonly WorkspaceRecord[], rules: readonly RuleDescriptor[]): string | undefined {
  for (const rule of rules) {
    const when = rule.when;
    if (!isRecord(when)) continue;
    const operation = text(when.operation);
    const missingRole = text(when.missing_relationship_role);
    if (operation && operation !== action.display_role && operation !== action.operation) continue;
    if (missingRole && records.some((record) => record.relationships.some((rel) => rel.role === missingRole))) continue;
    return rule.label;
  }
  return undefined;
}

function workspaceAction(action: ActionDescriptor, records: readonly WorkspaceRecord[], rules: readonly RuleDescriptor[]): WorkspaceAction {
  const blocked_reason = actionBlocked(action, records, rules);
  return {
    id: action.id,
    label: action.label,
    operation: text(action.operation, 'record.write-batch'),
    target: text(action.target, 'engine.operation.write-batch'),
    definition_id: text(action.definition_id, '') || undefined,
    display_role: text(action.display_role, '') || undefined,
    input: isRecord(action.input) ? action.input : {},
    blocked: !!blocked_reason,
    blocked_reason,
  };
}

function stateFor(input: ConfiguredRecordWorkspaceInput, records: readonly WorkspaceRecord[], proposals: readonly WorkspaceProposal[]): string {
  if (input.state) return input.state;
  if ((input.issues ?? []).length > 0 || records.some((record) => record.issue_refs.length > 0)) return 'error';
  if (input.process_state) return input.process_state;
  if (proposals.length > 0) return 'proposal-ready';
  if (records.length === 0) return 'empty';
  return records.length >= 30 ? 'dense' : 'sparse';
}

export function readConfiguredRecordWorkspace(input: ConfiguredRecordWorkspaceInput): ConfiguredRecordWorkspaceModel {
  const descriptors = mergeDescriptors(input);
  const view = descriptors.views[0] ?? { id: 'workspace', label: 'Workspace' };
  const records = (input.records ?? [])
    .map((record, index) => workspaceRecord(record, descriptors.fields, index))
    .filter((record): record is WorkspaceRecord => !!record)
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
  const sources = (input.source_material ?? [])
    .map(sourceMaterial)
    .filter((source): source is SourceMaterial => !!source);
  const proposals = materializeStructuredProposalRows(input.proposals ?? []);
  const selected = records.find((record) => record.ref === input.selected_ref) ?? records[0] ?? null;
  const actions = descriptors.actions.map((action) => workspaceAction(action, records, descriptors.rules));
  return {
    state: stateFor(input, records, proposals),
    reader_key: text(input.reader_key, 'browser'),
    view,
    sections: view.sections ?? [],
    empty: {
      title: text(view.empty?.title, 'No records yet'),
      actions: view.empty?.actions ?? [],
    },
    sources,
    records,
    selected,
    proposals,
    actions,
    rules: descriptors.rules,
    issues: input.issues ?? [],
    proof: {
      descriptor_counts: {
        fields: descriptors.fields.length,
        relationships: descriptors.relationships.length,
        views: descriptors.views.length,
        actions: descriptors.actions.length,
        rules: descriptors.rules.length,
      },
      source_record_count: records.length,
      proposal_count: proposals.length,
      selected_ref: selected?.ref ?? null,
    },
  };
}
