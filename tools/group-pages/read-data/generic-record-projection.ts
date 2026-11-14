export type PrimitiveValue = string | number | boolean | null;
export type JsonValue = PrimitiveValue | JsonValue[] | { [key: string]: JsonValue };

export interface FieldDescriptor {
  id: string;
  label: string;
  paths: string[][];
  hidden?: boolean;
}

export interface RelationshipDescriptor {
  id: string;
  label: string;
  source_path: string[];
  target_path: string[];
  display?: {
    category?: string;
    label_path?: string[];
    tone_path?: string[];
  };
}

export interface StatusDescriptor {
  id: string;
  label: string;
  tone?: string;
  mark?: string;
}

export interface ProjectionDescriptor {
  id: string;
  label: string;
  record_sources: Array<{ role: string }>;
  title_field?: string;
  columns: string[];
  relationship_refs?: string[];
  actions?: string[];
  empty?: {
    title: string;
    detail?: string;
  };
}

export interface OwnerActionInvokeDescriptor {
  target: string;
  operation?: string;
  action_definition_id?: string;
  include_steps?: boolean;
  include_output?: boolean;
}

export interface InputBindingDescriptor {
  key: string;
  label: string;
  required?: boolean;
  default_value?: JsonValue;
}

export interface ActionDescriptor {
  id: string;
  label: string;
  owner_invoke?: OwnerActionInvokeDescriptor;
  input_bindings?: InputBindingDescriptor[];
  payload_template?: Record<string, JsonValue>;
  metadata?: Record<string, JsonValue>;
  local_acknowledgement?: boolean;
}

export interface GenericRecordProjectionActionContract {
  kind: 'generic-record-projection-action-contract';
  package: string;
  version: number;
  record_sources: Array<{ role: string; address_label: string; codec?: string }>;
  field_descriptors: FieldDescriptor[];
  relationship_descriptors: RelationshipDescriptor[];
  projection_descriptors: ProjectionDescriptor[];
  status_descriptors: StatusDescriptor[];
  action_descriptors: ActionDescriptor[];
}

export interface SourceRecord {
  id: string;
  role: string;
  payload: Record<string, unknown>;
}

export interface ProjectedField {
  id: string;
  label: string;
  value: unknown;
  text: string;
}

export interface ProjectedRelationship {
  id: string;
  label: string;
  source: string;
  target: string;
  display?: {
    category?: string;
    label?: string;
    tone?: string;
  };
}

export interface ProjectedRecord {
  id: string;
  sourceRole: string;
  title: string;
  fields: ProjectedField[];
  relationships: ProjectedRelationship[];
}

export interface MaterializedProjection {
  id: string;
  label: string;
  records: ProjectedRecord[];
  actions: Array<{ id: string; label: string; enabled: boolean }>;
  empty: { title: string; detail?: string };
  proof: {
    descriptorCounts: {
      fields: number;
      relationships: number;
      projections: number;
      statuses: number;
      actions: number;
    };
    recordCount: number;
  };
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function valueAt(source: unknown, path: string[]): unknown {
  let current = source;
  for (const part of path) {
    const object = objectOf(current);
    if (!object || !(part in object)) return undefined;
    current = object[part];
  }
  return current;
}

function firstValue(source: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    const value = valueAt(source, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = valueAt(value, ['label']) ?? valueAt(value, ['text']) ?? valueAt(value, ['id']);
  if (typeof text === 'string' || typeof text === 'number' || typeof text === 'boolean') {
    return String(text).trim();
  }
  return JSON.stringify(value);
}

function fieldMap(contract: GenericRecordProjectionActionContract): Map<string, FieldDescriptor> {
  return new Map(contract.field_descriptors.map((field) => [field.id, field]));
}

function actionMap(contract: GenericRecordProjectionActionContract): Map<string, ActionDescriptor> {
  return new Map(contract.action_descriptors.map((action) => [action.id, action]));
}

function projectRelationships(
  record: SourceRecord,
  relationshipDescriptors: RelationshipDescriptor[],
): ProjectedRelationship[] {
  const relationships: ProjectedRelationship[] = [];
  for (const descriptor of relationshipDescriptors) {
    const source = textOf(valueAt(record.payload, descriptor.source_path)) || record.id;
    const target = textOf(valueAt(record.payload, descriptor.target_path));
    if (!source || !target) continue;
    relationships.push({
      id: `${descriptor.id}:${source}:${target}`,
      label: descriptor.label,
      source,
      target,
      display: descriptor.display ? {
        category: descriptor.display.category,
        label: textOf(valueAt(record.payload, descriptor.display.label_path ?? [])) || undefined,
        tone: textOf(valueAt(record.payload, descriptor.display.tone_path ?? [])) || undefined,
      } : undefined,
    });
  }
  return relationships;
}

export function materializeGenericRecordProjection(input: {
  contract: GenericRecordProjectionActionContract;
  records?: SourceRecord[];
  projection_id?: string;
  disabled_actions?: Record<string, string>;
}): MaterializedProjection {
  const contract = input.contract;
  const projection = contract.projection_descriptors.find((item) => item.id === input.projection_id)
    ?? contract.projection_descriptors[0];

  if (!projection) {
    return {
      id: 'missing-projection',
      label: 'Missing projection',
      records: [],
      actions: [],
      empty: { title: 'No projection descriptor' },
      proof: {
        descriptorCounts: {
          fields: contract.field_descriptors.length,
          relationships: contract.relationship_descriptors.length,
          projections: 0,
          statuses: contract.status_descriptors.length,
          actions: contract.action_descriptors.length,
        },
        recordCount: 0,
      },
    };
  }

  const fieldsById = fieldMap(contract);
  const actionsById = actionMap(contract);
  const sourceRoles = new Set(projection.record_sources.map((source) => source.role));
  const records = (input.records ?? []).filter((record) => sourceRoles.has(record.role));

  const projectedRecords = records.map((record) => {
    const fields = projection.columns
      .map((fieldId) => fieldsById.get(fieldId))
      .filter((field): field is FieldDescriptor => !!field && !field.hidden)
      .map((field) => {
        const value = firstValue(record.payload, field.paths);
        return { id: field.id, label: field.label, value, text: textOf(value) };
      });
    const titleField = projection.title_field ? fieldsById.get(projection.title_field) : undefined;
    const title = titleField
      ? textOf(firstValue(record.payload, titleField.paths))
      : fields.find((field) => field.text)?.text;
    return {
      id: record.id,
      sourceRole: record.role,
      title: title || record.id,
      fields,
      relationships: projectRelationships(
        record,
        contract.relationship_descriptors.filter((descriptor) =>
          !projection.relationship_refs || projection.relationship_refs.includes(descriptor.id),
        ),
      ),
    };
  });

  console.log('[group-page] generic record projection materialized', {
    projection: projection.id,
    records: projectedRecords.length,
  });

  return {
    id: projection.id,
    label: projection.label,
    records: projectedRecords,
    actions: (projection.actions ?? [])
      .map((actionId) => actionsById.get(actionId))
      .filter((action): action is ActionDescriptor => !!action)
      .map((action) => ({
        id: action.id,
        label: action.label,
        enabled: !input.disabled_actions?.[action.id],
      })),
    empty: projection.empty ?? { title: 'No records' },
    proof: {
      descriptorCounts: {
        fields: contract.field_descriptors.length,
        relationships: contract.relationship_descriptors.length,
        projections: contract.projection_descriptors.length,
        statuses: contract.status_descriptors.length,
        actions: contract.action_descriptors.length,
      },
      recordCount: projectedRecords.length,
    },
  };
}
