// packages/group/do-work/apply-producer-output.ts
//
// THE producer→group WRITE bridge. Dual-route application: merge-or-insert by identity.
// The ONLY translator between a producer envelope and group storage. group owns
// this because group owns group-EEAF translation (L098); a producer NEVER touches
// group records. Every producer — source-pull, cron, remote process — reuses this ONE seam;
// adding a producer is DATA, not bridge code (L069).
//
// Pure graph→graph (no I/O), exactly like the leaf ops it composes: an existing
// member MERGES its presentation (a result fills `src` on its pending
// item); a new member is INSERTED (a producer places a fresh item). The decision is
// identity alone — the bridge never reads the producer's name or the item's kind
// (L090). The resulting `after` graph flows through the EXISTING
// `buildGroupWriteBatch(before, after)` diff → one write-batch. Zero new write path.

import type { GroupGraph } from '../../ui/show/group/group-graph';
import { patchItems, addMembersVerbatim, patchItem } from '../read-data/group-board-model.ts';
import { normalizeProducerPresentation, type ProducerOutput } from '../read-data/producer-output.ts';

/**
 * Apply a producer's emitted members to its target group, returning the next
 * graph. Merge-vs-insert is decided per item by memberId identity:
 *   - existing memberId → merge presentation over the current member (patch)
 *   - new memberId      → place a new member carrying the presentation verbatim
 *
 * The target group is ensured first so the first producer run on an empty board
 * still lands. Presentation is opaque throughout — the bridge writes what the
 * producer emitted and reads none of it.
 *
 * Both routes are O(M+K), not the old per-item fold (setMemberFields / addMember each spread the whole
 * members map → O(K*M) = O(N^2) on a large producer output). `patchItems` patches the members already
 * present and SKIPS ids not yet in the group; `addMembersVerbatim` adds the absent ones verbatim, SKIPS
 * existing dups, and ensures the target group first — so sending EVERY item to BOTH cleanly partitions
 * merge-vs-insert with no extra existence read (producers emit unique memberIds).
 */
export function applyProducerOutput(graph: GroupGraph, output: ProducerOutput): GroupGraph {
  const targetRef = output.targetGroupRef;
  // EVERY emitted presentation flows through the canonical-presentation codec
  // (normalizeProducerPresentation) BEFORE it reaches storage: legacy nested
  // `extra` blobs are flattened + tombstoned, so exactly ONE stored encoding can
  // exist regardless of which producer (local, remote, live-feed) emitted the item.
  const normalized = output.items.map((item) => ({
    memberId: item.memberId,
    nodeRef: item.nodeRef,
    presentation: normalizeProducerPresentation(item.presentation),
  }));
  const merged = patchItems(
    graph,
    targetRef,
    normalized.map((item) => ({ memberId: item.memberId, patch: { ...item.presentation } })),
  );
  return addMembersVerbatim(
    merged,
    targetRef,
    normalized.map((item) => ({ memberId: item.memberId, nodeRef: item.nodeRef, presentation: item.presentation })),
  );
}

/** Keep usable results and the initiating card's failure together in one graph
 * update. Apply the failure last so a producer's status patch cannot hide it. */
export function applyPartialProducerOutput(graph: GroupGraph, output: ProducerOutput, initiatingMemberId: string): GroupGraph {
  return patchItem(applyProducerOutput(graph, output), output.targetGroupRef, initiatingMemberId, {
    status: 'error',
    message: 'Some results could not be read. Valid results were kept; existing cards were preserved.',
  });
}
