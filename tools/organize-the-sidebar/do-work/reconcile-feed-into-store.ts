// packages/group/do-work/reconcile-feed-into-store.ts
//
// THE invocation glue that makes a board MIRROR a live record feed. It composes
// the three shipped pure primitives against a `GroupBoardStore`:
//   load()  → the board's current graph (before)
//   recordFeedToProducerOutput(records, root, config) → the feed as pointer items
//   reconcileBoardGraphAuthoritative(before, output)  → after (add present, drop absent)
//   apply(before, after) → one write-batch diff (no-op when nothing changed)
// A live-feed board mount calls THIS in an effect whenever the feed changes; a
// server producer target could call it too. It is the ONLY place the four pieces
// meet, so the whole pipeline has ONE tested integration seam.
//
// BLIND (L090): it never reads a record's fields or names a product — the DATA
// `config` decides id/cluster/card-surface; this only orchestrates. Async I/O is
// isolated to the injected `store` (a fake store makes this fully unit-testable).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { getGroup, type AddressRef, type GroupGraph } from '../../ui/show/group/group-graph';
import type { GroupBoardStore } from '../read-data/read-group-board.ts';
import {
  recordFeedToProducerOutput,
  type FeedRecord,
  type FeedBoardProjectionConfig,
} from '../read-data/feed-board-projection.ts';
import type { ProducerOutput } from '../read-data/producer-output.ts';
import { reconcileBoardGraphAuthoritative, reconcileBoardGraph, absentMemberIds } from './reconcile-board-producer.ts';
import { buildGroupWriteBatch } from './group-mutation-writes.ts';
// Pure geometry leaf (zero I/O — do-work/batch-actions.ts already composes it).
import { arrangeByField } from '../show/arrange-by-field.ts';

/** What a reconcile pass did — for the caller's log/telemetry (no throw on no-op). */
export interface ReconcileFeedResult {
  /** True when the graph changed (a write-batch was attempted). */
  readonly changed: boolean;
  /** Members the feed says should exist (upserted). */
  readonly memberCount: number;
  /** Members removed because their record left the feed. */
  readonly removedCount: number;
  /** Members NEWLY added this pass (present in the feed, absent from `before`). */
  readonly addedCount: number;
  /**
   * True iff MEMBERSHIP changed (a worker was added or removed) — as opposed to a
   * pure field change on existing members. A live-feed mount should re-render the
   * board ONLY on membership change: every existing card LIVE-READS its own fields
   * (status/model/…) and self-updates, so a field tick needs NO board re-render.
   * This is what stops the "board resets to Loading… every clock tick" churn: the
   * ticking operator clock changes agent fields constantly, but membership rarely.
   */
  readonly membershipChanged: boolean;
}

/**
 * Reconcile a record feed into a board through its store. Loads the current graph,
 * projects the feed to pointer items, reconciles (authoritative membership), and
 * persists the diff. Returns what changed. When the feed produces no membership or
 * geometry change, `after === before` → `changed:false` and NO write is issued.
 *
 * Pure orchestration over the injected `store` — swap a fake store to unit-test the
 * whole pipeline end-to-end without a live engine.
 *
 * NO-OP DETECTION uses the real write-batch diff, not graph identity: `patchItems`
 * always returns a fresh graph reference (it re-writes every matched member), so
 * `after !== before` even when nothing changed. `buildGroupWriteBatch(before, after)`
 * yields ZERO writes iff the serialized groups are byte-identical — the honest
 * "did anything change" signal, and exactly what `store.apply` would send. So a
 * feed with no membership/field change issues no write (idempotent, no churn).
 */
/** The live-surface card footprint new members default to (placeable-surface-shelf's
 *  LIVE_SURFACE_FOOTPRINT — restated here to keep this do-work file free of show/ deps). */
const DEFAULT_ITEM_W = 380;
const DEFAULT_ITEM_H = 300;

/**
 * Seed x/y/w/h onto the items that are NEW to `before` (absent memberIds), laying
 * them out clustered by their `presentation.groupKey` via the SAME pure
 * `arrangeByField` leaf every board lens uses (L069 — one geometry primitive, not a
 * board-specific layout). Items already in `before` pass through UNTOUCHED (no
 * x/y/w/h in their presentation), so a merge can never move or resize a dragged
 * card — the seed/preserve split happens HERE, by identity, the only place both
 * the before-graph and the projected output are in hand. Deterministic (no
 * Date/random; cluster order + in-cluster order follow the projection's feed order).
 */
export function seedNewMemberPositions(
  before: GroupGraph,
  output: ProducerOutput,
  itemW: number = DEFAULT_ITEM_W,
  itemH: number = DEFAULT_ITEM_H,
): ProducerOutput {
  const existing = new Set(Object.keys(getGroup(before, output.targetGroupRef)?.members ?? {}));
  // CONNECTOR items (edges) carry NO position — their geometry is derived from their
  // endpoint node rects by ConnectorLayer. Only NODE items get an arranged seed; a
  // connector passed through arrangeByField would get a spurious x/y (harmless to the
  // render but noise in the graph). Partition by the structural connector shape (L090).
  const isConnector = (i: (typeof output.items)[number]): boolean =>
    typeof i.presentation.fromMemberId === 'string' && typeof i.presentation.toMemberId === 'string';
  const fresh = output.items.filter((i) => !existing.has(i.memberId) && !isConnector(i));
  if (fresh.length === 0) return output;
  const positions = new Map(
    arrangeByField(
      fresh.map((i) => ({
        memberId: i.memberId,
        w: itemW,
        h: itemH,
        groupKey: typeof i.presentation.groupKey === 'string' ? i.presentation.groupKey : '',
      })),
    ).map((p) => [p.memberId, p]),
  );
  return {
    ...output,
    items: output.items.map((i) => {
      const pos = positions.get(i.memberId);
      if (!pos) return i; // existing member — presentation stays free of x/y/w/h
      return { ...i, presentation: { ...i.presentation, x: pos.x, y: pos.y, w: itemW, h: itemH } };
    }),
  };
}

/** Options for {@link reconcileFeedIntoStore}. */
export interface ReconcileFeedOptions {
  /**
   * Whether the `records` feed is AUTHORITATIVE membership (the default, true).
   * A feed is authoritative only once it has actually DELIVERED — `useBitfieldData`
   * returns `null` until the first delivery, and `readPublishedRecords(null)` is `[]`.
   * If a caller reconciled that transient empty as authoritative, the SUBTRACTIVE
   * pass would tombstone EVERY existing member and persist an empty board (a real
   * loading state destroying real data — L117). So the I/O boundary (the mount)
   * passes `authoritative:false` until the feed has delivered; while non-authoritative
   * the reconcile is ADDITIVE-ONLY (upsert present, never remove). A DELIVERED feed
   * that decodes to zero records is authoritative and legitimately clears the board.
   */
  readonly authoritative?: boolean;
}

export async function reconcileFeedIntoStore(
  store: GroupBoardStore,
  records: readonly FeedRecord[],
  boardRootRef: AddressRef,
  config: FeedBoardProjectionConfig,
  options: ReconcileFeedOptions = {},
): Promise<ReconcileFeedResult> {
  const authoritative = options.authoritative ?? true;
  const before = await store.load();
  const projected = recordFeedToProducerOutput(records, boardRootRef, config);
  // New members get a clustered seed position; existing members stay untouched.
  const output = seedNewMemberPositions(before, projected, config.itemW, config.itemH);
  // AUTHORITATIVE: feed IS the membership (present→upsert, absent→tombstone).
  // NON-AUTHORITATIVE (feed not yet delivered): additive-only — upsert what we have,
  // remove NOTHING (reconcileBoardGraph with an empty remove list), so a transient
  // empty/loading feed can never wipe a populated board.
  const after = authoritative
    ? reconcileBoardGraphAuthoritative(before, output)
    : reconcileBoardGraph(before, output, []);
  const removedCount = authoritative
    ? absentMemberIds(
        before,
        boardRootRef,
        output.items.map((i) => i.memberId),
      ).length
    : 0;
  // Members NEW this pass = present in the feed output but absent from `before`.
  const existingIds = new Set(Object.keys(getGroup(before, boardRootRef)?.members ?? {}));
  const addedCount = output.items.filter((i) => !existingIds.has(i.memberId)).length;
  const membershipChanged = addedCount > 0 || removedCount > 0;

  const batch = buildGroupWriteBatch(before, after);
  if (batch.payload.writes.length === 0) {
    return { changed: false, memberCount: output.items.length, removedCount, addedCount, membershipChanged };
  }
  await store.apply(before, after);
  return { changed: true, memberCount: output.items.length, removedCount, addedCount, membershipChanged };
}
