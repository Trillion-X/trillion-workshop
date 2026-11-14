// package://packages/item-record/read-data/record-descriptors.ts
//
// Generic descriptor interpreter for item-shaped records. Domain words arrive
// through descriptor data; code only understands open roles and source keys.

/** Rendering topology roles are data values, never a catalog of product kinds. */
export type RecordRole = string;

export interface FieldDescriptor {
  id: string;
  role?: string;
  sourceKeys: string[];
}

export interface RoleDescriptor {
  role: RecordRole;
  values: string[];
}

export interface RelationshipDescriptor {
  id: string;
  role: string;
  sourceKeys: string[];
}

export interface ViewDescriptor {
  id: string;
  fieldIds: string[];
  relationshipIds?: string[];
}

export interface ItemRecordDescriptor {
  id: string;
  fields: FieldDescriptor[];
  roles: RoleDescriptor[];
  relationships: RelationshipDescriptor[];
  views: ViewDescriptor[];
}

export interface DescriptorValue {
  fieldId: string;
  value: unknown;
}

export interface DescriptorProjection {
  viewId: string;
  itemId: string;
  values: DescriptorValue[];
  relationships: DescriptorValue[];
}

export const defaultItemRecordDescriptor: ItemRecordDescriptor = {
  id: 'item-record.default',
  fields: [
    { id: 'id', role: 'identity', sourceKeys: ['item_ref', 'id', 'event_ref', 'request_ref'] },
    { id: 'title', role: 'title', sourceKeys: ['title', 'name', 'heading'] },
    { id: 'body', role: 'body', sourceKeys: ['body', 'text', 'message', 'content', 'summary'] },
    { id: 'actor', role: 'actor', sourceKeys: ['actor_ref', 'actorRef'] },
    { id: 'author', role: 'author', sourceKeys: ['author', 'author_name', 'authorName', 'actor_name'] },
    { id: 'created-at', role: 'created-at', sourceKeys: ['created_at', 'createdAt', 'requested_at', 'when', 'timestamp'] },
    { id: 'record-role-key', role: 'record-role-key', sourceKeys: ['kind'] },
    { id: 'category', role: 'facet', sourceKeys: ['categoryRef', 'category_ref'] },
    { id: 'pinned', role: 'priority', sourceKeys: ['pinned'] },
    { id: 'image', role: 'media', sourceKeys: ['image_url', 'imageUrl'] },
  ],
  roles: [],
  relationships: [
    { id: 'parent', role: 'parent', sourceKeys: ['parentRef', 'parent_ref'] },
    { id: 'target', role: 'target', sourceKeys: ['target_ref', 'targetRef'] },
  ],
  views: [
    {
      id: 'browser-dense',
      fieldIds: ['title', 'body', 'author', 'created-at', 'record-role-key', 'category', 'pinned', 'image'],
      relationshipIds: ['parent', 'target'],
    },
    {
      id: 'ios-compact',
      fieldIds: ['title', 'body', 'author', 'created-at', 'record-role-key'],
      relationshipIds: ['parent'],
    },
    {
      id: 'voice-summary',
      fieldIds: ['title', 'body', 'author', 'created-at'],
      relationshipIds: ['target'],
    },
  ],
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function unwrapJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[') && !text.startsWith('"')) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

export function textOf(value: unknown): string | null {
  const unwrapped = unwrapJson(value);
  if (typeof unwrapped === 'number' || typeof unwrapped === 'boolean') return String(unwrapped);
  if (typeof unwrapped !== 'string') return null;
  const trimmed = unwrapped.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function fieldsOf(row: Record<string, unknown>): Record<string, unknown> {
  const fields = unwrapJson(row.fields ?? row.value);
  return isPlainObject(fields) ? fields : {};
}

export function firstValue(
  row: Record<string, unknown>,
  fields: Record<string, unknown>,
  sourceKeys: string[],
): unknown {
  for (const key of sourceKeys) {
    if (row[key] !== undefined && row[key] !== null) return unwrapJson(row[key]);
    if (fields[key] !== undefined && fields[key] !== null) return unwrapJson(fields[key]);
  }
  return null;
}

export function firstText(
  row: Record<string, unknown>,
  fields: Record<string, unknown>,
  sourceKeys: string[],
): string | null {
  for (const key of sourceKeys) {
    const rowText = textOf(row[key]);
    if (rowText) return rowText;
    const fieldText = textOf(fields[key]);
    if (fieldText) return fieldText;
  }
  return null;
}

export function fieldByRole(
  descriptor: ItemRecordDescriptor,
  role: string,
): FieldDescriptor | undefined {
  return descriptor.fields.find((field) => field.role === role);
}

export function relationshipByRole(
  descriptor: ItemRecordDescriptor,
  role: string,
): RelationshipDescriptor | undefined {
  return descriptor.relationships.find((relationship) => relationship.role === role);
}

export function valueForFieldRole(
  descriptor: ItemRecordDescriptor,
  row: Record<string, unknown>,
  fields: Record<string, unknown>,
  role: string,
): unknown {
  const field = fieldByRole(descriptor, role);
  return field ? firstValue(row, fields, field.sourceKeys) : null;
}

export function textForFieldRole(
  descriptor: ItemRecordDescriptor,
  row: Record<string, unknown>,
  fields: Record<string, unknown>,
  role: string,
): string | null {
  const field = fieldByRole(descriptor, role);
  return field ? firstText(row, fields, field.sourceKeys) : null;
}

export function textForRelationshipRole(
  descriptor: ItemRecordDescriptor,
  row: Record<string, unknown>,
  fields: Record<string, unknown>,
  role: string,
): string | null {
  const relationship = relationshipByRole(descriptor, role);
  return relationship ? firstText(row, fields, relationship.sourceKeys) : null;
}

export function roleForRecord(
  descriptor: ItemRecordDescriptor,
  roleKey: string | null,
): RecordRole {
  if (!roleKey) return 'primary';
  for (const role of descriptor.roles) {
    if (role.values.includes(roleKey)) return role.role;
  }
  return 'primary';
}

export function projectRecordForView(
  descriptor: ItemRecordDescriptor,
  viewId: string,
  row: Record<string, unknown>,
  itemId: string,
): DescriptorProjection {
  const view = descriptor.views.find((candidate) => candidate.id === viewId);
  if (!view) {
    throw new Error(`Unknown item-record view descriptor: ${viewId}`);
  }
  const fields = fieldsOf(row);
  const values = view.fieldIds.map((fieldId) => {
    const field = descriptor.fields.find((candidate) => candidate.id === fieldId);
    return { fieldId, value: field ? firstValue(row, fields, field.sourceKeys) : null };
  });
  const relationships = (view.relationshipIds ?? []).map((relationshipId) => {
    const relationship = descriptor.relationships.find((candidate) => candidate.id === relationshipId);
    return {
      fieldId: relationshipId,
      value: relationship ? firstValue(row, fields, relationship.sourceKeys) : null,
    };
  });
  console.log(`[item-record] projection view=${viewId} rows=1`);
  return { viewId, itemId, values, relationships };
}
