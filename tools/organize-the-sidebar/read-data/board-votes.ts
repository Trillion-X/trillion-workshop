// packages/group/read-data/board-votes.ts
//
// The VOTE-TALLY primitive: a tally of dots cast by actors on a target. This ONE blind engine yields,
// from DATA alone, every dot-voting / prioritization feature a workshop board needs — a per-item vote
// count, per-participant vote BUDGET ("3 of 5 used"), rank-items-by-votes, and reset — with zero
// per-feature code (L069/L090). A tally is `Record<actorId, dotCount>` (an actor may stack multiple
// dots on one idea, FigJam/Miro canon). Pure + deterministic: the leaf reads/normalizes/reduces the
// self-describing DATA on the item (`extra.votes`) and never touches the graph — the bridge does.

/** A per-item tally: actor id → the number of dots that actor placed on this item (always >= 1). */
export type VoteTally = Readonly<Record<string, number>>;

/** An item paired with its tally — the input to the collection reducers (budget, ranking). */
export interface TalliedItem {
  readonly id: string;
  readonly tally: VoteTally;
}

/** The canonical empty tally (an item nobody voted for → no chip). */
export const EMPTY_TALLY: VoteTally = {};

/**
 * Normalize opaque DATA into a {@link VoteTally}, fail-closed: keep only `string -> positive integer`
 * entries (a malformed/negative/zero/NaN weight is dropped, never crashes the board). Non-object → {}.
 * Self-describing DATA + a generic reader (L090) — the chip/budget/ranking never parse by hand.
 */
export function tallyFromRaw(raw: unknown): VoteTally {
  // Reject non-objects AND arrays: a stray `extra.votes = [2]` is `typeof 'object'` but Object.entries would
  // turn index 0 into an actor id "0" with 2 dots — a bogus finite tally. A tally is a plain actor->count map.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_TALLY;
  // NULL-PROTOTYPE accumulator: `extra.votes` is untrusted, and a crafted data key like `'constructor'` would,
  // on a plain `{}`, become a PHANTOM actor (a fake voter in voterCount/rankByVotes/totalVotes), while a later
  // `tally['__proto__']` lookup in actorVotes/castVote would read Object.prototype (an inherited value). A
  // null-proto map has no inherited keys, so any string discriminant is a plain own key or absent — no phantom,
  // no inherited lookup. (Hardens the future multiplayer actor path too, per the convergence review.)
  const out: Record<string, number> = Object.create(null);
  for (const [actor, weight] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof weight === 'number' && Number.isInteger(weight) && weight > 0) out[actor] = weight;
  }
  return out;
}

/** Total dots on this item (the badge number). */
export function voteCount(tally: VoteTally): number {
  return Object.values(tally).reduce((sum, n) => sum + n, 0);
}

/** How many distinct actors voted for this item. */
export function voterCount(tally: VoteTally): number {
  return Object.keys(tally).length;
}

/** This actor's dots on this item (0 if none). */
export function actorVotes(tally: VoteTally, actor: string): number {
  return tally[actor] ?? 0;
}

/**
 * Cast `delta` dots for an actor (negative to retract), clamped so an actor never goes below 0. A
 * resulting count of 0 removes the actor's key entirely (an empty tally is `{}`, so the chip vanishes).
 * Pure — returns a new tally.
 */
export function castVote(tally: VoteTally, actor: string, delta = 1): VoteTally {
  const next = Math.max(0, (tally[actor] ?? 0) + delta);
  const out: Record<string, number> = { ...tally };
  if (next === 0) delete out[actor];
  else out[actor] = next;
  return out;
}

/** Remove an actor's votes from this item entirely. */
export function clearActor(tally: VoteTally, actor: string): VoteTally {
  if (!(actor in tally)) return tally;
  const out = { ...tally };
  delete out[actor];
  return out;
}

/** Dots this actor has spent across the WHOLE board — the numerator of the vote budget. */
export function actorBudgetUsed(items: readonly TalliedItem[], actor: string): number {
  return items.reduce((sum, it) => sum + actorVotes(it.tally, actor), 0);
}

/** Dots this actor has left, given a per-actor `budget` (never negative). */
export function actorBudgetRemaining(items: readonly TalliedItem[], actor: string, budget: number): number {
  return Math.max(0, budget - actorBudgetUsed(items, actor));
}

/** One row of the vote ranking: an item id + its total. */
export interface VoteRankRow {
  readonly id: string;
  readonly count: number;
}

/**
 * Items ranked by total votes, descending — the "top ideas" readout. Only items with at least one
 * vote appear (an unvoted board has an empty ranking). Ties keep input order (stable).
 */
export function rankByVotes(items: readonly TalliedItem[]): VoteRankRow[] {
  return items
    .map((it): VoteRankRow => ({ id: it.id, count: voteCount(it.tally) }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
}

/** Total dots cast across the whole board (every actor, every item) — a facilitation readout. */
export function totalVotes(items: readonly TalliedItem[]): number {
  return items.reduce((sum, it) => sum + voteCount(it.tally), 0);
}
