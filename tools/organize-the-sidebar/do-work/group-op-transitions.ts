// parts/group/do-work/group-op-transitions.ts
//
// PURPOSE
// The pure half of the group mutation door: the self-describing op payload, the
// capability map from op kind to leaf transition, and `applyGroupOp`. No I/O and no
// runtime imports, so any owner that holds a group graph applies the same ops the same
// way: the page's door (group-membership-actions.ts, over the page's records) and the
// Worker (src/sidebar.mjs, over the person's stored records for their AIs).
//
// NON-NEGOTIABLE INVARIANTS
//   - BLIND: ops carry meaning; the map carries mechanics. No `if (kind)` business
//     logic, only table dispatch; unknown kinds fail closed.
//   - PURE: graph in, graph out. Nothing here reads or writes a record.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import type { AddressRef, GroupGraph, Placement } from '../../ui/show/group/group-graph.ts';
import {
  addMember,
  groupKey,
  groupMembers,
  hasGroup,
  moveMember,
  patchMemberPresentation,
  removeMember,
  reorderMember,
  setMemberFields,
  ungroupMembers,
  ensureGroup,
} from '../../ui/show/group/group-graph.ts';

// ─────────────────────────────────────────────────────────────────────────────
// The self-describing op payload (machine-readable — each argument is its own
// explicit field, never an encoded string).
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupMutationOp {
  /** The capability discriminant. Resolved through OP_TRANSITIONS — never branched on. */
  readonly kind: string;
  /** The group being edited (or the parent group for group/ungroup ops). */
  readonly groupRef: AddressRef;
  /** The addressed thing being added (add-member). */
  readonly nodeRef?: AddressRef;
  /** Caller-minted member identity (the leaf never invents identity — I3). */
  readonly memberId?: string;
  /** Member ids selected for group-members. */
  readonly memberIds?: readonly string[];
  /** The new sub-group's address (group-members) / move destination (move-member). */
  readonly toGroupRef?: AddressRef;
  /** Wrapper member id for group-members / ungroup-members. */
  readonly wrapperMemberId?: string;
  /** Where to place a member in its group order. */
  readonly placement?: Placement;
  /** Opaque Society label for a member. Null clears (set-member-fields). */
  readonly role?: string | null;
  /** Opaque presentation payload for a member. Null clears (set-member-fields). */
  readonly presentation?: Readonly<Record<string, unknown>> | null;
}

/** One leaf transition: graph in, graph out. The whole capability contract. */
export type GroupOpTransition = (graph: GroupGraph, op: GroupMutationOp) => GroupGraph;

function required<T>(value: T | undefined | null, field: string, kind: string): T {
  if (value === undefined || value === null) {
    throw new Error(`group mutation '${kind}' requires '${field}'`);
  }
  return value;
}

/**
 * The capability map: op kind → leaf transition. Each entry only ADAPTS the op's
 * DATA fields to the leaf signature — zero membership logic lives here. This map
 * is exported so owner wiring can extend it (spread + add) without touching the
 * executor (enum dissolution: the list is data, the handler is generic).
 */
export const OP_TRANSITIONS: Readonly<Record<string, GroupOpTransition>> = {
  'ensure-group': (g, op) => ensureGroup(g, op.groupRef),
  'add-member': (g, op) =>
    addMember(g, op.groupRef, required(op.nodeRef, 'nodeRef', op.kind), {
      memberId: required(op.memberId, 'memberId', op.kind),
      ...(op.role != null ? { role: op.role } : {}),
      ...(op.presentation != null ? { presentation: op.presentation } : {}),
      ...(op.placement ? { placement: op.placement } : {}),
    }),
  'remove-member': (g, op) => removeMember(g, op.groupRef, required(op.memberId, 'memberId', op.kind)),
  'reorder-member': (g, op) =>
    reorderMember(
      g,
      op.groupRef,
      required(op.memberId, 'memberId', op.kind),
      required(op.placement, 'placement', op.kind),
    ),
  'move-member': (g, op) =>
    moveMember(g, required(op.memberId, 'memberId', op.kind), {
      fromGroupRef: op.groupRef,
      toGroupRef: required(op.toGroupRef, 'toGroupRef', op.kind),
      ...(op.placement ? { placement: op.placement } : {}),
    }),
  'set-member-fields': (g, op) =>
    setMemberFields(g, op.groupRef, required(op.memberId, 'memberId', op.kind), {
      role: op.role,
      presentation: op.presentation,
    }),
  'patch-member-presentation': (g, op) =>
    patchMemberPresentation(g, op.groupRef, required(op.memberId, 'memberId', op.kind), required(op.presentation, 'presentation', op.kind)),
  'group-members': (g, op) =>
    groupMembers(
      g,
      op.groupRef,
      required(op.memberIds, 'memberIds', op.kind),
      required(op.toGroupRef, 'toGroupRef', op.kind),
      {
        wrapperMemberId: required(op.wrapperMemberId, 'wrapperMemberId', op.kind),
        ...(op.role != null ? { role: op.role } : {}),
        ...(op.presentation != null ? { presentation: op.presentation } : {}),
      },
    ),
  'ungroup-members': (g, op) =>
    ungroupMembers(g, op.groupRef, required(op.wrapperMemberId, 'wrapperMemberId', op.kind)),
  // Deleting a group = the group vanishes from `after`; the write-set diff emits
  // its tombstone (append-only honest delete — the fold drops it on read).
  'delete-group': (g, op) => {
    if (!hasGroup(g, op.groupRef)) return g;
    const groups = { ...g.groups };
    delete groups[groupKey(op.groupRef)];
    return { groups };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// The pure transition (unit-test seam) and the live executor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply one self-describing op to a graph through a capability map. Pure —
 * throws on unknown kinds (fail-closed, never a silent no-op) and on any leaf
 * invariant violation (cycle, duplicate memberId, missing member).
 */
export function applyGroupOp(
  graph: GroupGraph,
  op: GroupMutationOp,
  transitions: Readonly<Record<string, GroupOpTransition>> = OP_TRANSITIONS,
): GroupGraph {
  const transition = transitions[op?.kind ?? ''];
  if (!transition) throw new Error(`unknown group mutation kind '${op?.kind}'`);
  return transition(graph, op);
}

/** Every root the executor must read before applying `op` (all refs the op touches). */
export function opRoots(op: GroupMutationOp): AddressRef[] {
  const roots: AddressRef[] = [op.groupRef];
  if (op.nodeRef) roots.push(op.nodeRef); // cycle detection needs the candidate's subtree
  if (op.toGroupRef) roots.push(op.toGroupRef);
  return roots;
}
