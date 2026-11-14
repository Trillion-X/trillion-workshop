export type RenderSurfaceDescriptor = {
  schema: 'render-surface-descriptor/v1';
  package_entry: {
    package_name: string;
    entry_name: string;
  };
  surface_input?: Record<string, unknown>;
  material_target?: string;
  target?: string;
};

export type AccessScopedItem = {
  id: string;
  content_ref: string;
  label?: string;
  summary?: string;
  collection_ref?: string;
  collection_label?: string;
  collection_order?: number;
  item_order?: number;
  // What this item sits INSIDE, by the id of that item. A program names nothing,
  // a module names its program, a lesson names its module, and depth is whatever
  // the rows describe. Nothing here knows the words program, module or lesson.
  parent_ref?: string;
  available: boolean;
  required_access_refs?: string[];
  access_decision_ref: string;
  access_decision_revision: number;
  access_decision_current_revision: number;
  render_surface: RenderSurfaceDescriptor;
};

export type AccessScopedContentProjection = AccessScopedItem;

export function accessDecisionIsCurrent(item: AccessScopedItem): boolean {
  if ((item.required_access_refs?.length ?? 0) > 0) return item.available === true;
  return item.available === true
    && item.access_decision_ref.trim().length > 0
    && Number.isSafeInteger(item.access_decision_revision)
    && item.access_decision_revision >= 0
    && item.access_decision_revision === item.access_decision_current_revision;
}

export function renderSurfaceIsValid(value: unknown): value is RenderSurfaceDescriptor {
  return isRecord(value)
    && value.schema === 'render-surface-descriptor/v1'
    && isRecord(value.package_entry)
    && nonEmpty(value.package_entry.package_name)
    && nonEmpty(value.package_entry.entry_name);
}

export function readAccessScopedContentProjection(source: unknown): AccessScopedContentProjection[] {
  const rows = Array.isArray(source) ? source : [];
  return rows
    .map(payloadFromRow)
    .filter(isAccessScopedItem);
}

export function readAccessScopedItems(source: unknown): AccessScopedItem[] {
  return readAccessScopedContentProjection(source);
}

function payloadFromRow(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const payload = value.payload ?? value.value ?? value;
  if (isRecord(payload) && payload.kind === 'screen-ready-record' && isRecord(payload.payload)) {
    return payload.payload;
  }
  return payload;
}

function isAccessScopedItem(value: unknown): value is AccessScopedItem {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.content_ref !== 'string') return false;
  const hasRequiredAccessRefs = Array.isArray(value.required_access_refs)
    && value.required_access_refs.length > 0
    && value.required_access_refs.every(nonEmpty);
  const hasDecisionRevision = nonEmpty(value.access_decision_ref)
    && Number.isSafeInteger(value.access_decision_revision)
    && Number.isSafeInteger(value.access_decision_current_revision);
  if (typeof value.available !== 'boolean' || (!hasRequiredAccessRefs && !hasDecisionRevision)) return false;
  return renderSurfaceIsValid(value.render_surface);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
