export type PlainRecord = Record<string, unknown>;

export type ValueType = 'text' | 'number' | 'boolean' | 'object' | 'list';

export interface FieldDescriptor {
  id: string;
  label: string;
  value_type: ValueType;
  allowed_values?: unknown[];
  range?: { min?: number; max?: number };
}

export interface RecordKindDescriptor {
  id: string;
  label: string;
  field_ids: string[];
}

export interface RelationshipDescriptor {
  id: string;
  label: string;
  source_kind?: string;
  target_role: string;
  field_ids?: string[];
}

export interface RuleDescriptor {
  id: string;
  label: string;
  effect: string;
  when?: {
    field_id: string;
    equals?: unknown;
    not_equals?: unknown;
  };
}

export interface ActionDescriptor {
  id: string;
  label: string;
  request_kind: 'write-batch' | 'workflow' | 'process-session';
  operation?: 'append-record' | 'replace-record' | 'append-relationship' | 'remove-record';
  record_kind?: string;
  relationship_id?: string;
  field_ids?: string[];
  target?: string;
  definition_id?: string;
  process?: PlainRecord;
  params?: PlainRecord;
}

export interface ProjectionDescriptor {
  id: string;
  label: string;
  subject_field_id: string;
  item_record_kind: string;
  visibility_rule_id?: string;
  score_field_id?: string;
  title_field_id?: string;
  body_field_id?: string;
  actor_field_id?: string;
  time_field_id?: string;
  version_field_id?: string;
  response_relationship_id?: string;
  signal_relationship_id?: string;
  concern_relationship_id?: string;
}

export interface ReaderDescriptor {
  id: string;
  label: string;
  projection_id: string;
  sections: string[];
}

export interface GenericRecordContracts {
  package: string;
  schema: string;
  record_kinds: RecordKindDescriptor[];
  fields: FieldDescriptor[];
  relationships: RelationshipDescriptor[];
  rules: RuleDescriptor[];
  actions: ActionDescriptor[];
  projections: ProjectionDescriptor[];
  readers: ReaderDescriptor[];
}

export interface ContractIndex {
  package: string;
  schema: string;
  recordKinds: Map<string, RecordKindDescriptor>;
  fields: Map<string, FieldDescriptor>;
  relationships: Map<string, RelationshipDescriptor>;
  rules: Map<string, RuleDescriptor>;
  actions: Map<string, ActionDescriptor>;
  projections: Map<string, ProjectionDescriptor>;
  readers: Map<string, ReaderDescriptor>;
}

export interface ContractValidationResult {
  ok: boolean;
  errors: Array<{ code: string; detail: string }>;
  counts: Record<string, number>;
}

const PACKAGE_SLUG = 'package-store-reviews';

export function isPlainRecord(value: unknown): value is PlainRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function listOfRecords(value: unknown): PlainRecord[] {
  return Array.isArray(value) ? value.filter(isPlainRecord) : [];
}

export function listOfText(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export function readPath(source: unknown, path: string[] = []): unknown {
  return path.reduce((current, segment) => (isPlainRecord(current) ? current[segment] : undefined), source);
}

export function indexById<T extends { id: string }>(values: T[]): Map<string, T> {
  return new Map(values.map((value) => [value.id, value]));
}

export function contractIndex(contracts: GenericRecordContracts): ContractIndex {
  return {
    package: contracts.package,
    schema: contracts.schema,
    recordKinds: indexById(contracts.record_kinds),
    fields: indexById(contracts.fields),
    relationships: indexById(contracts.relationships),
    rules: indexById(contracts.rules),
    actions: indexById(contracts.actions),
    projections: indexById(contracts.projections),
    readers: indexById(contracts.readers),
  };
}

export function validateContracts(contracts: GenericRecordContracts): ContractValidationResult {
  const errors: ContractValidationResult['errors'] = [];
  if (contracts.package !== PACKAGE_SLUG) {
    errors.push({ code: 'wrong-package', detail: String(contracts.package) });
  }
  const index = contractIndex(contracts);
  for (const recordKind of contracts.record_kinds) {
    for (const fieldId of recordKind.field_ids) {
      if (!index.fields.has(fieldId)) errors.push({ code: 'unknown-record-field', detail: `${recordKind.id}:${fieldId}` });
    }
  }
  for (const relationship of contracts.relationships) {
    for (const fieldId of relationship.field_ids ?? []) {
      if (!index.fields.has(fieldId)) errors.push({ code: 'unknown-relationship-field', detail: `${relationship.id}:${fieldId}` });
    }
  }
  for (const rule of contracts.rules) {
    if (rule.when && !index.fields.has(rule.when.field_id)) errors.push({ code: 'unknown-rule-field', detail: `${rule.id}:${rule.when.field_id}` });
  }
  for (const action of contracts.actions) {
    if (action.record_kind && !index.recordKinds.has(action.record_kind)) errors.push({ code: 'unknown-action-record-kind', detail: `${action.id}:${action.record_kind}` });
    if (action.relationship_id && !index.relationships.has(action.relationship_id)) errors.push({ code: 'unknown-action-relationship', detail: `${action.id}:${action.relationship_id}` });
    for (const fieldId of action.field_ids ?? []) {
      if (!index.fields.has(fieldId)) errors.push({ code: 'unknown-action-field', detail: `${action.id}:${fieldId}` });
    }
  }
  for (const projection of contracts.projections) {
    const fieldIds = [
      projection.subject_field_id,
      projection.score_field_id,
      projection.title_field_id,
      projection.body_field_id,
      projection.actor_field_id,
      projection.time_field_id,
      projection.version_field_id,
    ].filter((value): value is string => Boolean(value));
    if (!index.recordKinds.has(projection.item_record_kind)) errors.push({ code: 'unknown-projection-record-kind', detail: `${projection.id}:${projection.item_record_kind}` });
    for (const fieldId of fieldIds) {
      if (!index.fields.has(fieldId)) errors.push({ code: 'unknown-projection-field', detail: `${projection.id}:${fieldId}` });
    }
    if (projection.visibility_rule_id && !index.rules.has(projection.visibility_rule_id)) errors.push({ code: 'unknown-projection-rule', detail: `${projection.id}:${projection.visibility_rule_id}` });
  }
  for (const reader of contracts.readers) {
    if (!index.projections.has(reader.projection_id)) errors.push({ code: 'unknown-reader-projection', detail: `${reader.id}:${reader.projection_id}` });
  }
  return {
    ok: errors.length === 0,
    errors,
    counts: {
      record_kinds: contracts.record_kinds.length,
      fields: contracts.fields.length,
      relationships: contracts.relationships.length,
      rules: contracts.rules.length,
      actions: contracts.actions.length,
      projections: contracts.projections.length,
      readers: contracts.readers.length,
    },
  };
}

export function validateFieldValue(field: FieldDescriptor, value: unknown): string | null {
  if (value == null) return null;
  if (field.value_type === 'text' && typeof value !== 'string') return 'expected-text';
  if (field.value_type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return 'expected-number';
  if (field.value_type === 'boolean' && typeof value !== 'boolean') return 'expected-boolean';
  if (field.value_type === 'object' && !isPlainRecord(value)) return 'expected-object';
  if (field.value_type === 'list' && !Array.isArray(value)) return 'expected-list';
  if (field.allowed_values && !field.allowed_values.includes(value)) return 'value-not-allowed';
  if (typeof value === 'number') {
    if (typeof field.range?.min === 'number' && value < field.range.min) return 'number-below-range';
    if (typeof field.range?.max === 'number' && value > field.range.max) return 'number-above-range';
  }
  return null;
}
