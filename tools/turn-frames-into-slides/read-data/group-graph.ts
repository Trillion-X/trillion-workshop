// tools/turn-frames-into-slides/read-data/group-graph.ts
//
// PURPOSE
// The Universal Addressed Group — a blind, infinitely-nesting membership graph
// whose members are AddressRefs of ANY family (a tab, a container, a layout, a
// drawing, a replaceable surface, a board, or another group). This is the
// generative primitive behind vision boards, archives, source-collections, and
// life-log groupings (VB3-0 convergence, 2026-06-26): "a board IS a group; the
// archive IS a group of boards."
//
// NON-NEGOTIABLE INVARIANTS
//   I1. BLIND CORE (L090): the graph stores only `nodeRef.family + nodeRef.parts`.
//       It NEVER enumerates family — no NodeKind union, no switch(kind). New
//       families (drawing, board, anything invented tomorrow) work for free.
//   I2. NESTING BY REFERENCE (L069): a group is itself a node, so a member whose
//       `nodeRef` equals some group's `groupRef` nests that group. Sub-groups are
//       not a special case — they emerge from the one membership rule.
//   I3. PURE (no ambient authority): every operation is a pure function of its
//       inputs returning a NEW graph; unchanged groups are shared by reference
//       (structural sharing → O(1) change detection upstream). No Date/random —
//       the caller supplies every memberId. The leaf never invents identity.
//   I4. ONE PHYSICS INVARIANT: a group can never transitively contain itself.
//       This is the only closed rule (a real cycle is impossible in a tree of
//       containment); everything else is open Society data.
//   I5. MACHINE-READABLE: the graph is plain JSON (Records, not Maps) so it
//       serializes directly into EEAF without a codec.
//
// KEY CONCEPTS
//   - Ordering is array position (`memberOrder: string[]`), mirroring the
//     existing TabGroup (`tabIds`) and visual-layer-stack models — SSOT-consistent,
//     no order-key exhaustion. Scale comes from NESTING, not flat sibling count.
//   - The graph is a flat map of groups keyed by `serializeNodeRef(groupRef)`.
//     Containment is expressed by a member's `nodeRef` pointing at a group key.
//     A member may reference a node that is not (yet) a group in this graph — the
//     core is blind to whether the referenced node exists elsewhere.

import type { AddressRef } from './visual-layer-types.ts';
import { serializeNodeRef } from './node-ref.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Data model (plain JSON — I5)
// ─────────────────────────────────────────────────────────────────────────────

/** One membership edge: an addressed node belongs to a group, with opaque hints. */
export interface GroupMember {
  /** Stable id within this graph (caller-supplied — I3). Unique within its group. */
  readonly memberId: string;
  /** The addressed thing. Any family. May equal a group's groupRef → nesting (I2). */
  readonly nodeRef: AddressRef;
  /** Opaque Society label (e.g. "cover", "pinned"). The core never reads it. */
  readonly role?: string;
  /** Opaque presentation hints carried for the renderer. The core never reads them. */
  readonly presentation?: Readonly<Record<string, unknown>>;
}

/** A group: its own address + an ordered list of members. A group is also a node. */
export interface Group {
  readonly groupRef: AddressRef;
  /** Ordered memberIds — array position IS the order. */
  readonly memberOrder: readonly string[];
  /** memberId → member. */
  readonly members: Readonly<Record<string, GroupMember>>;
}

/** The whole graph: groups keyed by `serializeNodeRef(groupRef)`. */
export interface GroupGraph {
  readonly groups: Readonly<Record<string, Group>>;
}

/** Thrown when an operation would violate a Physics invariant (I4) or address nothing. */
export class GroupGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroupGraphError';
  }
}

/** Where to place a member in a group's order. Absent → append to end. */
export type Placement =
  | { readonly index: number }
  | { readonly before: string }
  | { readonly after: string }
  | { readonly at: 'start' | 'end' };

// ─────────────────────────────────────────────────────────────────────────────
// Construction & reads
// ─────────────────────────────────────────────────────────────────────────────

export function emptyGraph(): GroupGraph {
  return { groups: {} };
}

/** The map key for a group address. */
export function groupKey(groupRef: AddressRef): string {
  return serializeNodeRef(groupRef);
}

export function getGroup(graph: GroupGraph, groupRef: AddressRef): Group | null {
  return graph.groups[groupKey(groupRef)] ?? null;
}

export function hasGroup(graph: GroupGraph, groupRef: AddressRef): boolean {
  return groupKey(groupRef) in graph.groups;
}

/** Ordered members of a group (empty array if the group is absent). */
export function membersOf(graph: GroupGraph, groupRef: AddressRef): GroupMember[] {
  const group = getGroup(graph, groupRef);
  if (!group) return [];
  return group.memberOrder.map((id) => group.members[id]).filter(Boolean) as GroupMember[];
}

export function memberById(graph: GroupGraph, groupRef: AddressRef, memberId: string): GroupMember | null {
  return getGroup(graph, groupRef)?.members[memberId] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

function resolveIndex(order: readonly string[], placement?: Placement): number {
  if (!placement || ('at' in placement && placement.at === 'end')) return order.length;
  if ('at' in placement) return placement.at === 'start' ? 0 : order.length;
  if ('index' in placement) return clamp(placement.index, 0, order.length);
  if ('before' in placement) {
    const i = order.indexOf(placement.before);
    return i < 0 ? order.length : i;
  }
  // 'after'
  const i = order.indexOf(placement.after);
  return i < 0 ? order.length : i + 1;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function withGroup(graph: GroupGraph, group: Group): GroupGraph {
  return { groups: { ...graph.groups, [groupKey(group.groupRef)]: group } };
}

function withoutGroup(graph: GroupGraph, groupRef: AddressRef): GroupGraph {
  const next = { ...graph.groups };
  delete next[groupKey(groupRef)];
  return { groups: next };
}

/** Remove a group record after its memberships have been detached or promoted. */
export function removeGroup(graph: GroupGraph, groupRef: AddressRef): GroupGraph {
  return withoutGroup(graph, groupRef);
}

/**
 * Does `candidate` transitively reach `target` through the groups map?
 * Used to forbid cycles (I4): adding `candidate` into group `target` is illegal
 * if `candidate` is `target` or contains `target` at any depth.
 */
export function reaches(graph: GroupGraph, candidate: AddressRef, target: AddressRef): boolean {
  const targetKey = groupKey(target);
  const seen = new Set<string>();
  const stack: string[] = [groupKey(candidate)];
  while (stack.length) {
    const key = stack.pop()!;
    if (key === targetKey) return true;
    if (seen.has(key)) continue;
    seen.add(key);
    const group = graph.groups[key];
    if (!group) continue; // candidate node is not a group here → leaf, blind (I1)
    for (const id of group.memberOrder) {
      const m = group.members[id];
      if (m) stack.push(groupKey(m.nodeRef));
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutations (each returns a NEW graph — I3)
// ─────────────────────────────────────────────────────────────────────────────

/** Ensure a group exists (no-op if present). */
export function ensureGroup(graph: GroupGraph, groupRef: AddressRef): GroupGraph {
  if (hasGroup(graph, groupRef)) return graph;
  return withGroup(graph, { groupRef, memberOrder: [], members: {} });
}

/**
 * Add `nodeRef` as a member of `groupRef` at `placement` (default: end).
 * The group is created if absent. Throws on a duplicate memberId or a cycle (I4).
 */
export function addMember(
  graph: GroupGraph,
  groupRef: AddressRef,
  nodeRef: AddressRef,
  args: { memberId: string; role?: string; presentation?: Readonly<Record<string, unknown>>; placement?: Placement },
): GroupGraph {
  const { memberId, role, presentation, placement } = args;
  if (reaches(graph, nodeRef, groupRef)) {
    throw new GroupGraphError(
      `cycle: ${serializeNodeRef(nodeRef)} already contains (or is) ${serializeNodeRef(groupRef)}`,
    );
  }
  const base = getGroup(graph, groupRef) ?? { groupRef, memberOrder: [], members: {} };
  if (memberId in base.members) {
    throw new GroupGraphError(`duplicate memberId ${memberId} in group ${groupKey(groupRef)}`);
  }
  const member: GroupMember = pruneUndefined({ memberId, nodeRef, role, presentation });
  const at = resolveIndex(base.memberOrder, placement);
  const memberOrder = [...base.memberOrder.slice(0, at), memberId, ...base.memberOrder.slice(at)];
  return withGroup(graph, { groupRef, memberOrder, members: { ...base.members, [memberId]: member } });
}

/** Remove a member from a group (no-op if absent). The group itself stays. */
export function removeMember(graph: GroupGraph, groupRef: AddressRef, memberId: string): GroupGraph {
  const group = getGroup(graph, groupRef);
  if (!group || !(memberId in group.members)) return graph;
  const members = { ...group.members };
  delete members[memberId];
  return withGroup(graph, {
    groupRef,
    memberOrder: group.memberOrder.filter((id) => id !== memberId),
    members,
  });
}

/** Reorder a member within its group. */
export function reorderMember(
  graph: GroupGraph,
  groupRef: AddressRef,
  memberId: string,
  placement: Placement,
): GroupGraph {
  const group = getGroup(graph, groupRef);
  if (!group || !(memberId in group.members)) {
    throw new GroupGraphError(`no member ${memberId} in group ${groupKey(groupRef)}`);
  }
  const without = group.memberOrder.filter((id) => id !== memberId);
  const at = resolveIndex(without, placement);
  return withGroup(graph, {
    ...group,
    memberOrder: [...without.slice(0, at), memberId, ...without.slice(at)],
  });
}

/**
 * Move a member from one group to another (or reorder within one group when
 * from === to). Preserves the member's identity, nodeRef, role, presentation.
 * Throws on a cycle (I4) or if the source member is absent.
 */
export function moveMember(
  graph: GroupGraph,
  memberId: string,
  args: { fromGroupRef: AddressRef; toGroupRef: AddressRef; placement?: Placement },
): GroupGraph {
  const { fromGroupRef, toGroupRef, placement } = args;
  if (groupKey(fromGroupRef) === groupKey(toGroupRef)) {
    return reorderMember(graph, fromGroupRef, memberId, placement ?? { at: 'end' });
  }
  const member = memberById(graph, fromGroupRef, memberId);
  if (!member) throw new GroupGraphError(`no member ${memberId} in group ${groupKey(fromGroupRef)}`);
  const removed = removeMember(graph, fromGroupRef, memberId);
  return addMember(removed, toGroupRef, member.nodeRef, {
    memberId,
    role: member.role,
    presentation: member.presentation,
    placement,
  });
}

/** Set opaque fields on a member (role / presentation). Pass null to clear a field. */
export function setMemberFields(
  graph: GroupGraph,
  groupRef: AddressRef,
  memberId: string,
  fields: { role?: string | null; presentation?: Readonly<Record<string, unknown>> | null },
): GroupGraph {
  const group = getGroup(graph, groupRef);
  const current = group?.members[memberId];
  if (!group || !current) throw new GroupGraphError(`no member ${memberId} in group ${groupKey(groupRef)}`);
  const next: GroupMember = pruneUndefined({
    memberId: current.memberId,
    nodeRef: current.nodeRef,
    role: fields.role === null ? undefined : fields.role ?? current.role,
    presentation: fields.presentation === null ? undefined : fields.presentation ?? current.presentation,
  });
  return withGroup(graph, { ...group, members: { ...group.members, [memberId]: next } });
}

/** Merge named presentation fields against the current member within the same
 * group mutation. Callers must not copy an old presentation snapshot into a
 * later write: that can erase an intervening edit to an unrelated field. */
export function patchMemberPresentation(
  graph: GroupGraph,
  groupRef: AddressRef,
  memberId: string,
  patch: Readonly<Record<string, unknown>>,
): GroupGraph {
  const current = getGroup(graph, groupRef)?.members[memberId];
  if (!current) throw new GroupGraphError(`no member ${memberId} in group ${groupKey(groupRef)}`);
  return setMemberFields(graph, groupRef, memberId, {
    presentation: { ...current.presentation, ...patch },
  });
}

/**
 * Wrap selected members of `parentGroupRef` into a NEW group `newGroupRef`, which
 * becomes a single member of the parent at the position of the first selection.
 * The "select N things → group them" operation. The new group can be grouped,
 * nested, or moved again with zero new code (I2).
 */
export function groupMembers(
  graph: GroupGraph,
  parentGroupRef: AddressRef,
  memberIds: readonly string[],
  newGroupRef: AddressRef,
  args: { wrapperMemberId: string; role?: string; presentation?: Readonly<Record<string, unknown>> },
): GroupGraph {
  const parent = getGroup(graph, parentGroupRef);
  if (!parent) throw new GroupGraphError(`no group ${groupKey(parentGroupRef)}`);
  const selected = memberIds.filter((id) => id in parent.members);
  if (selected.length === 0) throw new GroupGraphError('groupMembers: no selected members exist');
  if (reaches(graph, newGroupRef, parentGroupRef) || hasGroup(graph, newGroupRef)) {
    throw new GroupGraphError(`newGroupRef ${groupKey(newGroupRef)} already exists or would cycle`);
  }
  const insertAt = parent.memberOrder.findIndex((id) => selected.includes(id));

  // Build the new sub-group from the selected members, preserving relative order.
  const orderedSelected = parent.memberOrder.filter((id) => selected.includes(id));
  const subMembers: Record<string, GroupMember> = {};
  for (const id of orderedSelected) subMembers[id] = parent.members[id];
  const subGroup: Group = { groupRef: newGroupRef, memberOrder: orderedSelected, members: subMembers };

  // Parent loses the selected members; gains one wrapper member pointing at the sub-group.
  const remainingMembers = { ...parent.members };
  for (const id of selected) delete remainingMembers[id];
  const wrapper: GroupMember = pruneUndefined({
    memberId: args.wrapperMemberId,
    nodeRef: newGroupRef,
    role: args.role,
    presentation: args.presentation,
  });
  remainingMembers[args.wrapperMemberId] = wrapper;
  const remainingOrder = parent.memberOrder.filter((id) => !selected.includes(id));
  const at = clamp(insertAt, 0, remainingOrder.length);
  const parentOrder = [...remainingOrder.slice(0, at), args.wrapperMemberId, ...remainingOrder.slice(at)];

  let next = withGroup(graph, { groupRef: parentGroupRef, memberOrder: parentOrder, members: remainingMembers });
  next = withGroup(next, subGroup);
  return next;
}

/**
 * Dissolve a sub-group: the member `wrapperMemberId` of `parentGroupRef` must
 * point at a group; its members are lifted back into the parent at the wrapper's
 * position (preserving order) and the sub-group + wrapper are removed.
 */
export function ungroupMembers(
  graph: GroupGraph,
  parentGroupRef: AddressRef,
  wrapperMemberId: string,
): GroupGraph {
  const parent = getGroup(graph, parentGroupRef);
  const wrapper = parent?.members[wrapperMemberId];
  if (!parent || !wrapper) throw new GroupGraphError(`no member ${wrapperMemberId} in ${groupKey(parentGroupRef)}`);
  const subGroup = getGroup(graph, wrapper.nodeRef);
  if (!subGroup) throw new GroupGraphError(`member ${wrapperMemberId} does not address a group`);

  const at = parent.memberOrder.indexOf(wrapperMemberId);
  const lifted = subGroup.memberOrder; // already ordered
  const members = { ...parent.members };
  delete members[wrapperMemberId];
  for (const id of lifted) members[id] = subGroup.members[id];
  const before = parent.memberOrder.slice(0, at);
  const after = parent.memberOrder.slice(at + 1);
  const memberOrder = [...before, ...lifted, ...after];

  let next = withGroup(graph, { groupRef: parentGroupRef, memberOrder, members });
  next = withoutGroup(next, wrapper.nodeRef);
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialization / validation (machine-readable, I5)
// ─────────────────────────────────────────────────────────────────────────────

/** Structural validator — true iff `value` is a well-formed GroupGraph. */
export function isGroupGraph(value: unknown): value is GroupGraph {
  if (!value || typeof value !== 'object') return false;
  const groups = (value as { groups?: unknown }).groups;
  if (!groups || typeof groups !== 'object') return false;
  for (const group of Object.values(groups as Record<string, unknown>)) {
    if (!isGroup(group)) return false;
  }
  return true;
}

function isGroup(value: unknown): value is Group {
  if (!value || typeof value !== 'object') return false;
  const g = value as Record<string, unknown>;
  if (!isAddressRef(g.groupRef)) return false;
  if (!Array.isArray(g.memberOrder) || !g.memberOrder.every((id) => typeof id === 'string')) return false;
  if (!g.members || typeof g.members !== 'object') return false;
  for (const m of Object.values(g.members as Record<string, unknown>)) {
    if (!isMember(m)) return false;
  }
  return true;
}

function isMember(value: unknown): value is GroupMember {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return typeof m.memberId === 'string' && isAddressRef(m.nodeRef);
}

function isAddressRef(value: unknown): value is AddressRef {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.family === 'string' && !!r.parts && typeof r.parts === 'object';
}

/** Drop keys whose value is undefined so serialized members stay minimal. */
function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}
