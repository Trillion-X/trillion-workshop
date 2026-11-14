/**
 * The composed-space owner stores a descriptor only.  Items, participation,
 * and evidence relations are independent owner projections supplied to this
 * fold as opaque rows; this module neither imports nor interprets their
 * source packages.
 */
export const COMPOSED_SPACE_PROPS = [
  'prop:composed_space:space_kind',
  'prop:composed_space:title',
  'prop:composed_space:subtitle',
  'prop:composed_space:icon',
  'prop:composed_space:layout_ref',
  'prop:composed_space:field_descriptor_refs',
  'prop:composed_space:action_descriptor_refs',
  'prop:composed_space:created_by',
  'prop:composed_space:created_at',
  'prop:composed_space:order',
  'prop:composed_space:revision',
] as const;

export type AttributeRow = {
  subjectId: string;
  propertyId: string;
  value: unknown;
  scopeRef?: string;
  revision?: unknown;
};

export type AdmittedSpaceScope = {
  actor_ref: string;
  decision_proof: string;
  session_ref: string;
  subject_ref: string;
  revisions: {
    membership_revision: string;
    policy_revision: string;
    resource_revision: string;
    session_revision: string;
  };
};

export type OpenDescriptor = {
  ref: string;
  label: string;
  summary: string;
  layout_ref: string;
  field_refs: string[];
  action_refs: string[];
};

export type ComposedSpace = {
  id: string;
  spaceId: string;
  kind: string;
  title: string;
  subtitle: string;
  icon: string;
  layoutRef: string;
  fieldDescriptorRefs: string[];
  actionDescriptorRefs: string[];
  ownerRef: string;
  createdAt: string;
  order: string;
  revision: number;
};

export type ScopedItemRow = {
  item_ref: string;
  scope_ref: string;
  target_ref: string;
  revision?: unknown;
  idempotency_ref?: unknown;
  fields?: unknown;
};

export type ScopedParticipantRow = {
  participation_ref: string;
  subject_ref: string;
  actor_ref: string;
  revision?: unknown;
  state_ref?: unknown;
  role_ref?: unknown;
  display_name?: unknown;
};

export type ScopedRelationRow = {
  relation_ref: string;
  scope_ref: string;
  target_ref: string;
  revision?: unknown;
  source_ref?: unknown;
  role_ref?: unknown;
};

export type NormalizedSpaceView = ComposedSpace & {
  items: ScopedItemRow[];
  participants: ScopedParticipantRow[];
  relationsByItem: Map<string, ScopedRelationRow[]>;
};

export type ScopedSpaceProjection = {
  descriptor_rows?: unknown;
  item_rows?: unknown;
  participant_rows?: unknown;
  relation_rows?: unknown;
  descriptors?: unknown;
};

const property = (name: string) => `prop:composed_space:${name}`;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
const revision = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(text(value));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const list = (value: unknown): string[] => Array.isArray(value)
  ? value.map(text).filter(Boolean)
  : (() => { try { const parsed = JSON.parse(text(value)); return Array.isArray(parsed) ? parsed.map(text).filter(Boolean) : []; } catch { return []; } })();
const rows = <T>(value: unknown): T[] => Array.isArray(value)
  ? value as T[]
  : object(value) && Array.isArray(object(value)!.items)
    ? object(value)!.items as T[]
    : [];

export function isAdmittedSpaceScope(value: unknown): value is AdmittedSpaceScope {
  const candidate = object(value);
  const revisions = object(candidate?.revisions);
  return Boolean(candidate
    && [candidate.actor_ref, candidate.decision_proof, candidate.session_ref, candidate.subject_ref].every((entry) => text(entry))
    && revisions
    && ['membership_revision', 'policy_revision', 'resource_revision', 'session_revision'].every((key) => text(revisions[key])));
}

/** This request targets the composed-space owner, never a slot selected by a caller. */
export function buildScopedComposedSpaceQuery(scope: AdmittedSpaceScope) {
  if (!isAdmittedSpaceScope(scope)) throw new Error('missing-admitted-scope');
  return { target: 'composed-space.read-scoped-projection', payload: { admission: scope } };
}

export function foldSpaces(rowsInput: readonly AttributeRow[], scope: unknown): ComposedSpace[] {
  if (!isAdmittedSpaceScope(scope)) return [];
  const spaces = new Map<string, Partial<ComposedSpace>>();
  for (const row of rowsInput) {
    if (!row.subjectId || !row.propertyId || row.scopeRef !== scope.subject_ref) continue;
    const space = spaces.get(row.subjectId) ?? { id: row.subjectId };
    if (row.propertyId === property('space_kind')) space.kind = text(row.value);
    if (row.propertyId === property('title')) space.title = text(row.value);
    if (row.propertyId === property('subtitle')) space.subtitle = text(row.value);
    if (row.propertyId === property('icon')) space.icon = text(row.value);
    if (row.propertyId === property('layout_ref')) space.layoutRef = text(row.value);
    if (row.propertyId === property('field_descriptor_refs')) space.fieldDescriptorRefs = list(row.value);
    if (row.propertyId === property('action_descriptor_refs')) space.actionDescriptorRefs = list(row.value);
    if (row.propertyId === property('created_by')) space.ownerRef = text(row.value);
    if (row.propertyId === property('created_at')) space.createdAt = text(row.value);
    if (row.propertyId === property('order')) space.order = text(row.value);
    if (row.propertyId === property('revision')) space.revision = revision(row.value);
    spaces.set(row.subjectId, space);
  }
  return [...spaces.values()]
    .filter((space) => Boolean(space.kind || space.title))
    .map((space) => ({
      id: space.id!,
      spaceId: space.id!.replace(/^composed-space:/, ''),
      kind: space.kind || 'unknown',
      title: space.title || 'Untitled space',
      subtitle: space.subtitle || '',
      icon: space.icon || '',
      layoutRef: space.layoutRef || '',
      fieldDescriptorRefs: space.fieldDescriptorRefs || [],
      actionDescriptorRefs: space.actionDescriptorRefs || [],
      ownerRef: space.ownerRef || '',
      createdAt: space.createdAt || '',
      order: space.order || '',
      revision: revision(space.revision),
    }))
    .sort((left, right) => left.order.localeCompare(right.order) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function scopedItems(value: unknown, scope: AdmittedSpaceScope): ScopedItemRow[] {
  return rows<ScopedItemRow>(value).filter((row) => object(row)
    && text(row.scope_ref) === scope.subject_ref
    && text(row.item_ref)
    && text(row.target_ref));
}

function scopedParticipants(value: unknown, scope: AdmittedSpaceScope): ScopedParticipantRow[] {
  return rows<ScopedParticipantRow>(value).filter((row) => object(row)
    && text(row.subject_ref) === scope.subject_ref
    && text(row.participation_ref)
    && text(row.actor_ref));
}

function scopedRelations(value: unknown, scope: AdmittedSpaceScope): ScopedRelationRow[] {
  return rows<ScopedRelationRow>(value).filter((row) => object(row)
    && text(row.scope_ref) === scope.subject_ref
    && text(row.relation_ref)
    && text(row.target_ref));
}

export function composeScopedSpaceProjection(input: ScopedSpaceProjection | unknown, scope: unknown): NormalizedSpaceView[] {
  if (!isAdmittedSpaceScope(scope)) return [];
  const projection = object(input) ?? {};
  const descriptors = foldSpaces(rows<AttributeRow>(projection.descriptor_rows ?? projection.descriptors), scope);
  const items = scopedItems(projection.item_rows, scope);
  const participants = scopedParticipants(projection.participant_rows, scope);
  const relations = scopedRelations(projection.relation_rows, scope);
  const result = descriptors.map((descriptor) => {
    const targetItems = items.filter((item) => item.target_ref === descriptor.id);
    const relationsByItem = new Map<string, ScopedRelationRow[]>();
    for (const relation of relations) {
      if (!targetItems.some((item) => item.item_ref === relation.target_ref)) continue;
      relationsByItem.set(relation.target_ref, [...(relationsByItem.get(relation.target_ref) ?? []), relation]);
    }
    return { ...descriptor, items: targetItems, participants, relationsByItem };
  });
  console.info(`[composed-space.project] subject=${scope.subject_ref} descriptors=${result.length} participants=${participants.length} items=${items.length} relations=${relations.length}`);
  return result;
}

/**
 * Descriptor records are Society data. Unknown records retain their explicit
 * reference and receive a bounded, visibly generic rendering fallback.
 */
export function decodeOpenDescriptor(value: unknown): OpenDescriptor {
  const raw = object(value) ?? {};
  const ref = text(raw.ref ?? raw.id ?? raw.kind_ref ?? raw.layout_ref) || 'unknown-descriptor';
  return {
    ref,
    label: text(raw.label ?? raw.title) || ref.replace(/[-_]/g, ' '),
    summary: text(raw.summary ?? raw.description),
    layout_ref: text(raw.layout_ref),
    field_refs: list(raw.field_refs ?? raw.field_descriptor_refs),
    action_refs: list(raw.action_refs ?? raw.action_descriptor_refs),
  };
}

function stringsWithin(value: unknown, knownRefs: Set<string>, output: string[] = []): string[] {
  if (typeof value === 'string' && knownRefs.has(value)) output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => stringsWithin(entry, knownRefs, output));
  else if (object(value)) Object.values(value as Record<string, unknown>).forEach((entry) => stringsWithin(entry, knownRefs, output));
  return output;
}

export type CycleSafeSpaceProjection = { reachable_refs: string[]; cycle_refs: string[]; truncated: boolean };

/** A data graph may self-place or mutually nest; rendering reports, rather than hides, a cycle. */
export function projectCycleSafeSpaces(spaces: readonly NormalizedSpaceView[], startRef: string, maxDepth = 32): CycleSafeSpaceProjection {
  const byRef = new Map(spaces.map((space) => [space.id, space]));
  const knownRefs = new Set(byRef.keys());
  const reachable = new Set<string>();
  const cycles = new Set<string>();
  let truncated = false;
  const visit = (ref: string, ancestry: Set<string>, depth: number) => {
    if (depth > maxDepth) { truncated = true; return; }
    if (ancestry.has(ref)) { cycles.add(ref); return; }
    const space = byRef.get(ref);
    if (!space || reachable.has(`${ref}@${[...ancestry].join('/')}`)) return;
    reachable.add(ref);
    const nextAncestry = new Set(ancestry).add(ref);
    for (const item of space.items) {
      for (const childRef of stringsWithin(item.fields, knownRefs)) visit(childRef, nextAncestry, depth + 1);
    }
  };
  visit(startRef, new Set(), 0);
  return { reachable_refs: [...reachable].sort(), cycle_refs: [...cycles].sort(), truncated };
}
