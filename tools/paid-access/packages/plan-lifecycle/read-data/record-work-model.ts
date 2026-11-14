export type JsonObject = Record<string, unknown>;

export interface RecordWorkRow {
  address?: string;
  role?: string;
  payload?: unknown;
}

export interface FieldDescriptor {
  id: string;
  label: string;
  paths: readonly (readonly string[])[];
  empty?: string;
  format?: {
    kind?: string;
    maximumFractionDigits?: number;
    minimumFractionDigits?: number;
  };
}

export interface RelationshipDescriptor {
  id: string;
  label: string;
  fromRole?: string;
  toRole?: string;
  fromField?: string;
  toField?: string;
}

export interface ProjectionDescriptor {
  id: string;
  label: string;
  sourceRole: string;
  titleField?: string;
  detailFields?: readonly string[];
  summaryFields?: readonly string[];
  relationshipIds?: readonly string[];
  empty?: {
    title?: string;
    detail?: string;
  };
}

export interface RuleDescriptor {
  id: string;
  message: string;
  severity?: string;
  when?: {
    missingRole?: string;
    fieldEquals?: { role: string; path: readonly string[]; value: unknown };
    fieldNotEquals?: { role: string; path: readonly string[]; value: unknown };
  };
}

export interface OwnerTargetDescriptor {
  id: string;
  target: string;
  operation?: string;
  definitionId?: string;
  includeSteps?: boolean;
  includeOutput?: boolean;
}

export interface ActionDescriptor {
  id: string;
  label: string;
  ownerTargetId: string;
  subjectRole?: string;
  requiredRuleIds?: readonly string[];
  copy?: readonly ActionInputCopy[];
  input?: JsonObject;
}

export interface ActionInputCopy {
  key: string;
  from?: string;
  value?: unknown;
}

export interface DescriptorSet {
  fields?: readonly FieldDescriptor[];
  relationships?: readonly RelationshipDescriptor[];
  projections?: readonly ProjectionDescriptor[];
  rules?: readonly RuleDescriptor[];
  ownerTargets?: readonly OwnerTargetDescriptor[];
  actions?: readonly ActionDescriptor[];
}

export interface ReadRecordWorkModelInput {
  rows?: unknown;
  descriptors?: DescriptorSet;
}

export interface ModelValue {
  fieldId: string;
  label: string;
  value: unknown;
  text: string;
}

export interface ModelRelationship {
  id: string;
  label: string;
  targets: readonly string[];
}

export interface ModelItem {
  id: string;
  title: string;
  detail: string;
  values: readonly ModelValue[];
  relationships: readonly ModelRelationship[];
  raw: JsonObject;
}

export interface ModelBlocker {
  ruleId: string;
  message: string;
  severity?: string;
}

export interface ModelAction {
  id: string;
  label: string;
  ownerTarget: OwnerTargetDescriptor;
  subjectId?: string;
  input?: JsonObject;
  copy: readonly ActionInputCopy[];
  blocked: boolean;
  blockedReason?: string;
}

export interface RecordWorkModel {
  projectionId: string;
  title: string;
  items: readonly ModelItem[];
  summary: readonly ModelValue[];
  blockers: readonly ModelBlocker[];
  actions: readonly ModelAction[];
  empty: { title: string; detail: string };
  revision: string;
  proof: {
    descriptorCount: number;
    sourceRecordCount: number;
    relationshipCount: number;
  };
}

const DESCRIPTOR_KINDS = new Set([
  'record-work.field-descriptors',
  'record-work.relationship-descriptors',
  'record-work.projection-descriptors',
  'record-work.rule-descriptors',
  'record-work.owner-target-descriptors',
  'record-work.action-descriptors',
]);

export function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rowsFrom(raw: unknown): RecordWorkRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is RecordWorkRow => isJsonObject(row));
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
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function firstText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function itemId(record: JsonObject, index: number): string {
  return firstText(record.id) ?? firstText(record.record_id) ?? firstText(record.address) ?? `record:${index}`;
}

function formatValue(value: unknown, field?: FieldDescriptor): string {
  if (value === undefined || value === null || value === '') return field?.empty ?? '';
  if (field?.format?.kind === 'number' && typeof value === 'number') {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: field.format.maximumFractionDigits ?? 2,
      minimumFractionDigits: field.format.minimumFractionDigits,
    }).format(value);
  }
  if (field?.format?.kind === 'date' && typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
  if (Array.isArray(value)) return value.map((entry) => formatValue(entry)).filter(Boolean).join(', ');
  if (isJsonObject(value)) return JSON.stringify(value);
  return String(value);
}

function fieldById(fields: readonly FieldDescriptor[], id?: string): FieldDescriptor | undefined {
  return id ? fields.find((field) => field.id === id) : undefined;
}

function readField(record: unknown, field?: FieldDescriptor): unknown {
  if (!field) return undefined;
  for (const path of field.paths) {
    const value = readPath(record, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function valueFor(record: JsonObject, field: FieldDescriptor): ModelValue {
  const value = readField(record, field);
  return { fieldId: field.id, label: field.label, value, text: formatValue(value, field) };
}

function rowsByRole(rows: readonly RecordWorkRow[]): Record<string, JsonObject[]> {
  const byRole: Record<string, JsonObject[]> = {};
  for (const row of rows) {
    if (typeof row.role !== 'string' || !isJsonObject(row.payload)) continue;
    byRole[row.role] = [...(byRole[row.role] ?? []), row.payload];
  }
  return byRole;
}

function descriptorPayloads(rows: readonly RecordWorkRow[]): DescriptorSet {
  const descriptors: DescriptorSet = {};
  for (const row of rows) {
    if (!isJsonObject(row.payload) || typeof row.payload.kind !== 'string' || !DESCRIPTOR_KINDS.has(row.payload.kind)) {
      continue;
    }
    if (Array.isArray(row.payload.fields)) descriptors.fields = row.payload.fields as FieldDescriptor[];
    if (Array.isArray(row.payload.relationships)) descriptors.relationships = row.payload.relationships as RelationshipDescriptor[];
    if (Array.isArray(row.payload.projections)) descriptors.projections = row.payload.projections as ProjectionDescriptor[];
    if (Array.isArray(row.payload.rules)) descriptors.rules = row.payload.rules as RuleDescriptor[];
    if (Array.isArray(row.payload.ownerTargets)) descriptors.ownerTargets = row.payload.ownerTargets as OwnerTargetDescriptor[];
    if (Array.isArray(row.payload.actions)) descriptors.actions = row.payload.actions as ActionDescriptor[];
  }
  return descriptors;
}

function mergeDescriptors(supplied: DescriptorSet | undefined, fromRows: DescriptorSet): Required<DescriptorSet> {
  return {
    fields: supplied?.fields ?? fromRows.fields ?? [],
    relationships: supplied?.relationships ?? fromRows.relationships ?? [],
    projections: supplied?.projections ?? fromRows.projections ?? [],
    rules: supplied?.rules ?? fromRows.rules ?? [],
    ownerTargets: supplied?.ownerTargets ?? fromRows.ownerTargets ?? [],
    actions: supplied?.actions ?? fromRows.actions ?? [],
  };
}

function ruleBlocked(rule: RuleDescriptor, byRole: Record<string, JsonObject[]>): boolean {
  if (rule.when?.missingRole) return (byRole[rule.when.missingRole]?.length ?? 0) === 0;
  if (rule.when?.fieldEquals) {
    const clause = rule.when.fieldEquals;
    return (byRole[clause.role] ?? []).some((record) => readPath(record, clause.path) === clause.value);
  }
  if (rule.when?.fieldNotEquals) {
    const clause = rule.when.fieldNotEquals;
    return (byRole[clause.role] ?? []).some((record) => readPath(record, clause.path) !== clause.value);
  }
  return false;
}

function evaluateRules(rules: readonly RuleDescriptor[], byRole: Record<string, JsonObject[]>): ModelBlocker[] {
  return rules
    .filter((rule) => ruleBlocked(rule, byRole))
    .map((rule) => ({ ruleId: rule.id, message: rule.message, severity: rule.severity }));
}

function relationshipTargets(
  record: JsonObject,
  relationship: RelationshipDescriptor,
  byRole: Record<string, JsonObject[]>,
): string[] {
  const fromValue = relationship.fromField ? readPath(record, [relationship.fromField]) : itemId(record, 0);
  return (byRole[relationship.toRole ?? ''] ?? [])
    .filter((target) => !relationship.toField || readPath(target, [relationship.toField]) === fromValue)
    .map((target, index) => itemId(target, index));
}

function modelItems(
  records: readonly JsonObject[],
  descriptors: Required<DescriptorSet>,
  projection: ProjectionDescriptor,
  byRole: Record<string, JsonObject[]>,
): ModelItem[] {
  const titleField = fieldById(descriptors.fields, projection.titleField);
  const detailFields = (projection.detailFields ?? [])
    .map((id) => fieldById(descriptors.fields, id))
    .filter((field): field is FieldDescriptor => Boolean(field));
  const valueFields = descriptors.fields;
  const relationships = (projection.relationshipIds ?? [])
    .map((id) => descriptors.relationships.find((relationship) => relationship.id === id))
    .filter((relationship): relationship is RelationshipDescriptor => Boolean(relationship));

  return records.map((record, index) => {
    const title = formatValue(readField(record, titleField), titleField) || itemId(record, index);
    return {
      id: itemId(record, index),
      title,
      detail: detailFields.map((field) => valueFor(record, field).text).filter(Boolean).join(' / '),
      values: valueFields.map((field) => valueFor(record, field)).filter((value) => value.text),
      relationships: relationships.map((relationship) => ({
        id: relationship.id,
        label: relationship.label,
        targets: relationshipTargets(record, relationship, byRole),
      })),
      raw: record,
    };
  });
}

function targetById(targets: readonly OwnerTargetDescriptor[], id: string): OwnerTargetDescriptor {
  const target = targets.find((entry) => entry.id === id);
  if (!target) throw new Error(`Owner target ${id} is not described.`);
  return target;
}

function actionsFor(
  descriptors: Required<DescriptorSet>,
  blockers: readonly ModelBlocker[],
  items: readonly ModelItem[],
): ModelAction[] {
  const blockerByRule = new Map(blockers.map((blocker) => [blocker.ruleId, blocker]));
  return descriptors.actions.map((action) => {
    const blockingRule = (action.requiredRuleIds ?? []).map((id) => blockerByRule.get(id)).find(Boolean);
    const subject = action.subjectRole ? items[0] : undefined;
    return {
      id: action.id,
      label: action.label,
      ownerTarget: targetById(descriptors.ownerTargets, action.ownerTargetId),
      subjectId: subject?.id,
      input: action.input,
      copy: action.copy ?? [],
      blocked: Boolean(blockingRule),
      blockedReason: blockingRule?.message,
    };
  });
}

export function readRecordWorkModel(input: ReadRecordWorkModelInput): RecordWorkModel {
  const rows = rowsFrom(input.rows);
  const rowDescriptors = descriptorPayloads(rows);
  const descriptors = mergeDescriptors(input.descriptors, rowDescriptors);
  const byRole = rowsByRole(rows);
  const projection = descriptors.projections[0] ?? {
    id: 'record-work.default',
    label: 'Records',
    sourceRole: 'records',
    empty: { title: 'No records', detail: 'Records appear when source data arrives.' },
  };
  const sourceRecords = byRole[projection.sourceRole] ?? [];
  const items = modelItems(sourceRecords, descriptors, projection, byRole);
  const blockers = evaluateRules(descriptors.rules, byRole);
  const summary = items[0]
    ? (projection.summaryFields ?? [])
      .map((id) => fieldById(descriptors.fields, id))
      .filter((field): field is FieldDescriptor => Boolean(field))
      .map((field) => valueFor(items[0].raw, field))
      .filter((value) => value.text)
    : [];

  return {
    projectionId: projection.id,
    title: projection.label,
    items,
    summary,
    blockers,
    actions: actionsFor(descriptors, blockers, items),
    empty: {
      title: projection.empty?.title ?? 'No records',
      detail: projection.empty?.detail ?? 'Records appear when source data arrives.',
    },
    revision: `${rows.length}:${items.length}:${descriptors.fields.length}:${descriptors.actions.length}:${blockers.length}`,
    proof: {
      descriptorCount:
        descriptors.fields.length +
        descriptors.relationships.length +
        descriptors.projections.length +
        descriptors.rules.length +
        descriptors.ownerTargets.length +
        descriptors.actions.length,
      sourceRecordCount: sourceRecords.length,
      relationshipCount: items.reduce((sum, item) => sum + item.relationships.length, 0),
    },
  };
}
