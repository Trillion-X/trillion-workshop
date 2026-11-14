// package-set://bitfield-studio/packages/ideas/read-data/read-ideas.ts
//
// Descriptor-driven read model for the Ideas package. Package vocabulary lives
// in package data; this module only composes the generic visual-database primitive.

import {
  decodeVisualDatabaseActions,
  decodeVisualDatabaseFields,
  decodeVisualDatabaseModel,
  decodeVisualDatabaseViews,
  effectiveDomain,
  projectVisualDatabaseView,
  treeForRecords,
  type DecodeVisualDatabaseInput,
  type VisualDatabaseActionDescriptor,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseModel,
  type VisualDatabaseRecord,
  type VisualDatabaseViewDescriptor,
  type VisualDatabaseViewProjection,
} from '../../keep-lists-of-rows/read-data/visual-database.ts';

export interface IdeasWorkGraphInput {
  records: unknown;
  fields: unknown;
  views: unknown;
  actions: unknown;
  relationships?: unknown;
  operationLinks?: unknown;
  processSessionLinks?: unknown;
  domains?: Record<string, unknown>;
}

export interface IdeasRelationshipDescriptor {
  id: string;
  label: string;
  fieldId: string;
}

export interface IdeasOperationLinkDescriptor {
  id: string;
  label: string;
  transitionId?: string;
  actionId?: string;
  target?: string;
  operation?: string;
}

export interface IdeasProcessSessionLinkDescriptor {
  id: string;
  label: string;
  targetKey: string;
  recordFieldId?: string;
  sessionRefFieldId?: string;
}

export interface IdeasWorkGraph {
  model: VisualDatabaseModel;
  projection: VisualDatabaseViewProjection;
  fields: readonly VisualDatabaseFieldDescriptor[];
  views: readonly VisualDatabaseViewDescriptor[];
  actions: readonly VisualDatabaseActionDescriptor[];
  relationships: readonly IdeasRelationshipDescriptor[];
  operationLinks: readonly IdeasOperationLinkDescriptor[];
  processSessionLinks: readonly IdeasProcessSessionLinkDescriptor[];
  proof: {
    recordCount: number;
    fieldDescriptorCount: number;
    viewDescriptorCount: number;
    actionDescriptorCount: number;
    relationshipDescriptorCount: number;
    operationLinkCount: number;
    processSessionLinkCount: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readListContainer(value: unknown, key: string): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value[key])) return value[key] as readonly unknown[];
  return [];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readRelationship(value: unknown): IdeasRelationshipDescriptor | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const fieldId = readString(value.fieldId ?? value.field_id);
  if (!id || !fieldId) return null;
  return {
    id,
    label: readString(value.label) ?? id,
    fieldId,
  };
}

function readOperationLink(value: unknown): IdeasOperationLinkDescriptor | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  if (!id) return null;
  return {
    id,
    label: readString(value.label) ?? id,
    transitionId: readString(value.transitionId ?? value.transition_id),
    actionId: readString(value.actionId ?? value.action_id),
    target: readString(value.target),
    operation: readString(value.operation),
  };
}

function readProcessSessionLink(value: unknown): IdeasProcessSessionLinkDescriptor | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const targetKey = readString(value.targetKey ?? value.target_key);
  if (!id || !targetKey) return null;
  return {
    id,
    label: readString(value.label) ?? id,
    targetKey,
    recordFieldId: readString(value.recordFieldId ?? value.record_field_id),
    sessionRefFieldId: readString(value.sessionRefFieldId ?? value.session_ref_field_id),
  };
}

export function buildIdeasVisualDatabaseInput(input: IdeasWorkGraphInput): DecodeVisualDatabaseInput {
  return {
    records: input.records,
    fields: input.fields,
    views: input.views,
    actions: input.actions,
    domains: input.domains,
  };
}

export function decodeIdeasRelationships(raw: unknown): readonly IdeasRelationshipDescriptor[] {
  return readListContainer(raw, 'relationships')
    .map(readRelationship)
    .filter((item): item is IdeasRelationshipDescriptor => item !== null);
}

export function decodeIdeasOperationLinks(raw: unknown): readonly IdeasOperationLinkDescriptor[] {
  return readListContainer(raw, 'operationLinks')
    .map(readOperationLink)
    .filter((item): item is IdeasOperationLinkDescriptor => item !== null);
}

export function decodeIdeasProcessSessionLinks(raw: unknown): readonly IdeasProcessSessionLinkDescriptor[] {
  return readListContainer(raw, 'processSessionLinks')
    .map(readProcessSessionLink)
    .filter((item): item is IdeasProcessSessionLinkDescriptor => item !== null);
}

export function decodeIdeasWorkGraph(input: IdeasWorkGraphInput): IdeasWorkGraph {
  const model = decodeVisualDatabaseModel(buildIdeasVisualDatabaseInput(input));
  const fields = decodeVisualDatabaseFields(input.fields);
  const views = decodeVisualDatabaseViews(input.views);
  const actions = decodeVisualDatabaseActions(input.actions);
  const relationships = decodeIdeasRelationships(input.relationships);
  const operationLinks = decodeIdeasOperationLinks(input.operationLinks);
  const processSessionLinks = decodeIdeasProcessSessionLinks(input.processSessionLinks);
  const projection = projectVisualDatabaseView(model);

  return {
    model,
    projection,
    fields,
    views,
    actions,
    relationships,
    operationLinks,
    processSessionLinks,
    proof: {
      recordCount: model.records.length,
      fieldDescriptorCount: fields.length,
      viewDescriptorCount: views.length,
      actionDescriptorCount: actions.length,
      relationshipDescriptorCount: relationships.length,
      operationLinkCount: operationLinks.length,
      processSessionLinkCount: processSessionLinks.length,
    },
  };
}

export function relationshipTreeFor(
  records: readonly VisualDatabaseRecord[],
  fields: readonly VisualDatabaseFieldDescriptor[],
  relationship: IdeasRelationshipDescriptor,
) {
  const descriptor = fields.find((field) => field.id === relationship.fieldId);
  return descriptor ? treeForRecords(records, descriptor) : { roots: [] };
}

export function domainValuesFor(
  model: VisualDatabaseModel,
  fieldId: string,
  viewId?: string,
) {
  const field = model.fields.find((descriptor) => descriptor.id === fieldId);
  if (!field) return [];
  const view = viewId ? model.views.find((descriptor) => descriptor.id === viewId) : undefined;
  return effectiveDomain(field, model, view);
}
