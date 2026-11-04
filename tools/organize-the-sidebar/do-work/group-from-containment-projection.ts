// packages/group/do-work/group-from-containment-projection.ts
//
// PURPOSE
// The bridge: turn a containment projection of a foreign tree into a GroupGraph,
// so a hierarchy that lives outside the engine can be regrouped by the ontology
// that already owns membership and nesting.
//
// This is the ONLY piece that was missing. The rest of the path already exists:
// a decoder produces the projection, and `buildGroupWriteBatch(before, after)`
// in ./group-mutation-writes.ts turns two graphs into an engine write batch.
//
// NON-NEGOTIABLE INVARIANTS
//   B1. COMPOSES THE OWNER, NEVER HAND-BUILDS. Every group and member is created
//       through `ensureGroup` and `addMember`, so the graph's own cycle rule (I4)
//       and duplicate-member rule enforce themselves here for free. Constructing
//       the JSON directly would silently bypass both.
//   B2. BLIND TO THE SOURCE. Nothing here knows what a tab, a folder, a browser or
//       a bookmark is. `family` arrives as an argument because address family is
//       Society, and `role` is carried verbatim because the ontology declares it
//       opaque. A new source is a caller argument, never an edit here.
//   B3. IDENTITY IS THE SOURCE'S OWN. `node_id` becomes both the memberId and the
//       nodeRef parts. Never positional: regrouping is the entire point, and a
//       positional identity would churn every record on every run.
//   B4. ORDER IS THE PROJECTION'S ORDER. Records are placed by ascending `ordinal`,
//       because in a Group the array position IS the order.
//   B5. NOTHING IS SILENTLY DROPPED. A record that cannot be placed is returned in
//       `unplaced` with a reason. The caller decides; this never swallows.
//
// SECURITY
// Pure. No filesystem, network, process, or clock access. Every operation returns
// a new graph, so a caller cannot mutate a graph it does not own.

import type { AddressRef } from '../../ui/show/visual-layer-stack/visual-layer-types';
import {
  addMember,
  emptyGraph,
  ensureGroup,
  GroupGraphError,
  type GroupGraph,
} from '../../ui/show/group/group-graph';

/** One node of a foreign tree, as a decoder projects it. */
export interface ContainmentRecord {
  readonly node_id: string;
  readonly parent_id: string | null;
  readonly ordinal: number | null;
  /** Opaque label. `group` is structural; every other value is carried verbatim. */
  readonly role: string | null;
  readonly title: string;
  readonly external_identity: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/** A record that could not be placed, and why. Never silently discarded (B5). */
export interface UnplacedRecord {
  readonly node_id: string;
  readonly reason: 'no_parent' | 'cycle' | 'duplicate_member';
  readonly detail: string;
}

export interface ContainmentToGraphResult {
  readonly graph: GroupGraph;
  readonly unplaced: readonly UnplacedRecord[];
  readonly groupCount: number;
  readonly memberCount: number;
}

/** The role label that means "this node contains others". Structural, not Society. */
const CONTAINING_ROLE = 'group';

const refFor = (family: string, nodeId: string): AddressRef =>
  ({ family, parts: [nodeId] }) as AddressRef;

/**
 * Build a GroupGraph from a containment projection.
 *
 * `family` is the address family every node of this tree belongs to. It is an
 * argument rather than a constant because address family is Society (B2).
 *
 * Records are placed parents-before-children and then by ascending ordinal, so a
 * nested group exists as a group before anything tries to nest it (I2).
 */
export function groupGraphFromContainment(
  records: readonly ContainmentRecord[],
  family: string,
  base: GroupGraph = emptyGraph(),
): ContainmentToGraphResult {
  const unplaced: UnplacedRecord[] = [];
  let graph = base;

  // 1. Every containing node becomes a group first, so nesting can reference it.
  const containing = records.filter((record) => record.role === CONTAINING_ROLE);
  for (const record of containing) {
    graph = ensureGroup(graph, refFor(family, record.node_id));
  }

  // 2. Depth-ordered placement. A child is placed only after its parent, so a
  //    group nested inside another group is never placed into a group that does
  //    not exist yet. Depth is computed by walking parents, cycle-guarded.
  const parentOf = new Map<string, string | null>();
  for (const record of records) parentOf.set(record.node_id, record.parent_id);

  const depthOf = (nodeId: string): number => {
    let depth = 0;
    let cursor = parentOf.get(nodeId) ?? null;
    const seen = new Set<string>([nodeId]);
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = parentOf.get(cursor) ?? null;
    }
    return depth;
  };

  const placeable = records
    .filter((record) => record.parent_id !== null)
    .map((record) => ({ record, depth: depthOf(record.node_id) }))
    .sort((left, right) => {
      if (left.depth !== right.depth) return left.depth - right.depth;
      const leftOrdinal = left.record.ordinal ?? Number.MAX_SAFE_INTEGER;
      const rightOrdinal = right.record.ordinal ?? Number.MAX_SAFE_INTEGER;
      if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;
      return left.record.node_id < right.record.node_id ? -1 : 1;
    });

  for (const { record } of placeable) {
    const groupRef = refFor(family, record.parent_id as string);
    const nodeRef = refFor(family, record.node_id);
    const presentation = presentationFor(record);
    try {
      graph = addMember(graph, groupRef, nodeRef, {
        memberId: record.node_id,
        role: record.role ?? undefined,
        presentation,
      });
    } catch (error) {
      // The ontology refused it. Report which rule and move on (B5).
      const isCycle = error instanceof GroupGraphError && /cycle/.test(error.message);
      unplaced.push({
        node_id: record.node_id,
        reason: isCycle ? 'cycle' : 'duplicate_member',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 3. Records with no parent are roots or orphans. Reported, never dropped.
  for (const record of records) {
    if (record.parent_id !== null) continue;
    unplaced.push({
      node_id: record.node_id,
      reason: 'no_parent',
      detail: 'record has no parent, so it is a root or an orphan of this tree',
    });
  }

  const groupCount = Object.keys(graph.groups).length;
  const memberCount = Object.values(graph.groups)
    .reduce((total, group) => total + group.memberOrder.length, 0);

  return { graph, unplaced, groupCount, memberCount };
}

/**
 * Carry the human-facing and source-facing facts as opaque presentation. The
 * ontology declares this field opaque and never reads it, which is exactly why
 * a verbatim address survives here without the core learning what an address is.
 */
function presentationFor(record: ContainmentRecord): Readonly<Record<string, unknown>> | undefined {
  const presentation: Record<string, unknown> = { ...record.attributes };
  if (record.title) presentation.title = record.title;
  if (record.external_identity) presentation.external_identity = record.external_identity;
  return Object.keys(presentation).length > 0 ? presentation : undefined;
}
