// packages/group/do-work/board-votes-actions.ts
//
// The GRAPH bridge for the vote-tally primitive (read-data/board-votes): extract every item's tally as
// self-describing DATA, and mutate a single item's tally through the ONE tested `patchItem` write path.
// A tally lives ON the item as `extra.votes` (co-locates → moves + deletes with the item, rides along
// in shares/templates via the existing `extra` preservation). Connectors + auto furniture are never
// vote targets — you prioritize CONTENT, not the board's own scaffolding. Budget enforcement lives here
// (one rule, one place): a cast that would exceed the actor's per-board budget is a no-op.

import type { GroupGraph, AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { BoardItem } from '../read-data/group-board-model';
import { readItems, patchItem, itemIsConnector } from '../read-data/group-board-model';
import { itemIsBoardFurniture } from './batch-actions';
import {
  type TalliedItem,
  type VoteTally,
  EMPTY_TALLY,
  actorBudgetRemaining,
  castVote,
  clearActor,
  rankByVotes,
  tallyFromRaw,
  voteCount,
} from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-votes.ts';

/** An item is a vote TARGET iff it is real content (a note/frame/image/…), not a connector or furniture. */
export function itemIsVoteTarget(item: BoardItem): boolean {
  return !itemIsConnector(item) && !itemIsBoardFurniture(item);
}

/** The normalized tally on one item (EMPTY_TALLY when it has none / a malformed value). */
export function tallyOfItem(item: BoardItem): VoteTally {
  return tallyFromRaw(item.extra?.votes);
}

/** Every vote target on the board paired with its tally — the input to the budget + ranking reducers. */
export function boardTallies(items: readonly BoardItem[]): TalliedItem[] {
  return items.filter(itemIsVoteTarget).map((it): TalliedItem => ({ id: it.memberId, tally: tallyOfItem(it) }));
}

/** Read one item's tally from the live graph (EMPTY_TALLY if absent). */
export function tallyOf(graph: GroupGraph, ref: AddressRef, memberId: string): VoteTally {
  const item = readItems(graph, ref).find((it) => it.memberId === memberId);
  return item ? tallyOfItem(item) : EMPTY_TALLY;
}

/**
 * Cast (or retract with a negative delta) `delta` dots for an actor on an item, enforcing the actor's
 * per-board `budget`: a POSITIVE cast that would exceed the remaining budget is a NO-OP (returns the
 * graph unchanged). Retractions always apply. The new tally is written back via `patchItem` (merges
 * into the item's presentation, so every other `extra` field is preserved).
 */
export function castVoteOnItem(
  graph: GroupGraph,
  ref: AddressRef,
  memberId: string,
  actor: string,
  delta: number,
  budget: number,
): GroupGraph {
  if (delta > 0) {
    const remaining = actorBudgetRemaining(boardTallies(readItems(graph, ref)), actor, budget);
    if (remaining <= 0) return graph; // out of dots — no-op
    delta = Math.min(delta, remaining);
  }
  const next = castVote(tallyOf(graph, ref, memberId), actor, delta);
  return patchItem(graph, ref, memberId, { votes: next });
}

/** Clear ONE actor's votes from an item (retract my dots). */
export function clearActorOnItem(graph: GroupGraph, ref: AddressRef, memberId: string, actor: string): GroupGraph {
  return patchItem(graph, ref, memberId, { votes: clearActor(tallyOf(graph, ref, memberId), actor) });
}

/** Clear ALL votes from an item (facilitator reset for one idea). */
export function clearItemVotes(graph: GroupGraph, ref: AddressRef, memberId: string): GroupGraph {
  return patchItem(graph, ref, memberId, { votes: EMPTY_TALLY });
}

/** One ranking row for the "top voted" panel: the item + a human label + its total. */
export interface VoteRankingRow {
  readonly memberId: string;
  readonly label: string;
  readonly count: number;
}

/**
 * The vote-ranking rows (most-voted first) with each item's own text as its label — the DATA behind a
 * "top ideas" panel with jump-to. Pure read-model over `boardTallies` + `rankByVotes`.
 */
export function voteRankingRows(items: readonly BoardItem[]): VoteRankingRow[] {
  const byId = new Map(items.map((it) => [it.memberId, it]));
  const label = (id: string): string => {
    const t = byId.get(id)?.text;
    const trimmed = typeof t === 'string' ? t.trim() : '';
    return trimmed !== '' ? trimmed : id;
  };
  return rankByVotes(boardTallies(items)).map((r): VoteRankingRow => ({ memberId: r.id, label: label(r.id), count: r.count }));
}

/** Convenience for the badge: total dots on one item in the live graph. */
export function itemVoteCount(graph: GroupGraph, ref: AddressRef, memberId: string): number {
  return voteCount(tallyOf(graph, ref, memberId));
}
