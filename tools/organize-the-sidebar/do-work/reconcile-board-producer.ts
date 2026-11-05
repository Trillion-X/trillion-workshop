// packages/group/do-work/reconcile-board-producer.ts
//
// THE authoritative-membership producer seam. `apply-producer-output` covers the
// ADDITIVE half — a producer that MERGES/INSERTS items it found. But a LIVE-FEED
// board (every current record of a family IS the complete membership: agents,
// tasks, deals) also needs the SUBTRACTIVE half: a record that left the feed must
// leave the board. This composes the two existing generic group ops
// (`applyProducerOutput` + `removeItems`) into ONE graph→graph transition so every
// feed-backed board reconciles identically (SSOT for "the producer output is the
// authoritative set"). ZERO new persistence: the resulting `after` graph flows
// through the EXISTING `buildGroupWriteBatch(before, after)` diff.
//
// BLIND (L090): like the ops it composes, it never reads an item's kind/x/y/extra
// and never names a product ("agent"/"task"). A producer emits opaque items; this
// merges the present, removes the absent. The producer decides membership; group
// decides storage. Pure graph→graph (no I/O, no React, no Date/random).
//
// ARRANGEMENT PRESERVED: `applyProducerOutput` MERGES an existing member's
// presentation (`patchItems` = `{...current, ...patch}`), so an item whose
// presentation OMITS x/y keeps its stored position (a user's drag survives a
// reconcile). New items land verbatim with whatever seed position the producer
// supplied. This is the whole reason a live board can churn without resetting.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { membersOf, type GroupGraph } from '../../ui/show/group/group-graph';
import { removeItems } from '../read-data/group-board-model.ts';
import { applyProducerOutput } from './apply-producer-output.ts';
import type { ProducerOutput } from '../read-data/producer-output.ts';

/**
 * The memberIds currently in the target group that are NOT in `keepMemberIds` —
 * i.e. the members a reconcile must tombstone. Pure; order follows the group's
 * current member order (stable). An id in `keep` that isn't present is ignored.
 */
export function absentMemberIds(
  graph: GroupGraph,
  targetGroupRef: ProducerOutput['targetGroupRef'],
  keepMemberIds: Iterable<string>,
): string[] {
  const keep = new Set(keepMemberIds);
  return membersOf(graph, targetGroupRef)
    .map((m) => m.memberId)
    .filter((id) => !keep.has(id));
}

/**
 * Apply a producer output AND remove an explicit set of members in one transition.
 * `after = removeItems(applyProducerOutput(before, output), target, removeMemberIds)`.
 * Use when the caller already knows exactly which members to drop (e.g. a reconcile
 * core computed the tombstone list). Order is upsert-then-remove so a removed id
 * that also appears in `output.items` still ends up removed (explicit intent wins).
 */
export function reconcileBoardGraph(
  before: GroupGraph,
  output: ProducerOutput,
  removeMemberIds: readonly string[],
): GroupGraph {
  const upserted = applyProducerOutput(before, output);
  if (removeMemberIds.length === 0) return upserted;
  return removeItems(upserted, output.targetGroupRef, removeMemberIds);
}

/**
 * Reconcile treating the producer output as the AUTHORITATIVE membership: every
 * member of the target group NOT named by `output.items` is removed. This is the
 * one-call live-feed reconcile — the feed IS the truth, so the board mirrors it
 * exactly (present→upsert, absent→tombstone), while merges preserve arrangement.
 */
export function reconcileBoardGraphAuthoritative(before: GroupGraph, output: ProducerOutput): GroupGraph {
  const keep = output.items.map((item) => item.memberId);
  const upserted = applyProducerOutput(before, output);
  const toRemove = absentMemberIds(before, output.targetGroupRef, keep);
  if (toRemove.length === 0) return upserted;
  return removeItems(upserted, output.targetGroupRef, toRemove);
}

/**
 * Reconcile an UNTRUSTED producer result as the authoritative membership — but fail
 * SAFE on emptiness. A board-AI run's agent can fail, refuse, time out, or emit
 * malformed output that parses to zero items; feeding that empty set to the plain
 * authoritative reconcile would tombstone EVERY member (absent-from-output → removed)
 * and WIPE the user's board. This variant treats an empty result as "the production
 * produced nothing," NOT "the user wants an empty board," and returns `before`
 * untouched — so a flaky model response can never destroy a board. A non-empty result
 * delegates verbatim to {@link reconcileBoardGraphAuthoritative}, so genuine
 * reorganize/edit/regenerate is unchanged.
 *
 * Use this for any UNTRUSTED authoritative producer (an AI/agent whose output is not
 * guaranteed). For a TRUSTED feed (the DB record set IS the membership; an empty feed
 * legitimately means an empty board), call {@link reconcileBoardGraphAuthoritative}
 * directly — the two are deliberately distinct so the trust decision is explicit and
 * neither path second-guesses the other (SSOT: emptiness-means-clear stays with the
 * trusted feed; emptiness-means-nothing-happened stays with the untrusted result).
 */
export function reconcileBoardGraphFromUntrustedResult(before: GroupGraph, output: ProducerOutput, incomplete = false): GroupGraph {
  if (output.items.length === 0) return before; // fail-safe: no items produced → never destroy the board
  // A decoder may salvage valid items from malformed or bounded output. Keep
  // those useful updates, but absence from a partial result is not a deletion.
  if (incomplete) return applyProducerOutput(before, output);
  return reconcileBoardGraphAuthoritative(before, output);
}
