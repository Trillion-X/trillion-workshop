// packages/group/read-data/board-diff.ts
//
// BOARD DIFF — the blind, field-generic engine behind "what CHANGED between two versions of this board?".
// A whole capability category no other board reader covers: every existing readout describes ONE board
// state (census, agenda, waves, readiness); this COMPARES two. It is the substrate for versioning, review
// ("what did my collaborator change?"), template-drift ("how far has this board moved from the saved
// version?"), and merge-preview.
//
// It diffs two `BoardState`s — the SAME `Record<memberId, {field → value}>` representation the CRDT merge
// (board-merge) already folds to, so there is ONE canonical board-state shape (SSOT), not a diff-specific
// one. Each member is exactly one of three ALGEBRAIC states, fully determined by a truth-table over two
// facts (present in `before`? present in `after`?) plus field equality: `added` (only in after) / `removed`
// (only in before) / `changed` (in both, ≥1 field differs). This is NOT a Society enum (no user can add a
// 4th kind of change — it is the closed set of set-membership + equality), so the engine never branches on
// status; the changed-FIELD keys are reported verbatim as DATA (`x`,`text`,`extra`,…) and a caller's label
// map turns them human (the display twin pattern) — the engine hardcodes NO field name.
//
// Field equality is a deterministic structural deep-equal (primitives, arrays, plain objects with sorted-key
// comparison, null-safe) so a card's nested `extra` (style, marker, metric) compares correctly and a moved
// card (`x`/`y` differ) is distinguished from a renamed one (`text` differs) purely by which field keys land
// in `changedFields`. Pure, deterministic (every list sorted), zero I/O — a read-data leaf.

import type { BoardState, MemberState } from './board-merge.ts';

/** The closed, Physics-determined kind of change to a member between two board states. */
export type MemberChangeStatus = 'added' | 'removed' | 'changed';

/** One member's change. `changedFields` is the sorted field keys whose value differs (only for `changed`;
 *  empty for `added`/`removed`). */
export interface MemberDiff {
  readonly memberId: string;
  readonly status: MemberChangeStatus;
  readonly changedFields: readonly string[];
}

/** The full comparison of two board states. Every list is sorted (ids / by id) → deterministic. */
export interface BoardStateDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly MemberDiff[];
  /** Members identical in both states (a complete accounting; useful for "N unchanged"). */
  readonly unchanged: readonly string[];
}

/** Deterministic structural equality: primitives by ===, arrays element-wise, plain objects by sorted keys,
 *  null-safe. NaN is treated unequal (=== semantics) — a real value change, never a silent match. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/** The sorted field keys whose value differs between two member states (the union of both members' keys). */
export function changedFieldsBetween(before: MemberState, after: MemberState): string[] {
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  const out: string[] = [];
  for (const k of keys) if (!deepEqual(before[k], after[k])) out.push(k);
  return out.sort();
}

/** Compare two board states → added / removed / changed / unchanged. Pure, deterministic. */
export function diffBoardStates(before: BoardState, after: BoardState): BoardStateDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: MemberDiff[] = [];
  const unchanged: string[] = [];
  for (const id of Object.keys(after)) if (!(id in before)) added.push(id);
  for (const id of Object.keys(before)) {
    if (!(id in after)) {
      removed.push(id);
      continue;
    }
    const fields = changedFieldsBetween(before[id], after[id]);
    if (fields.length > 0) changed.push({ memberId: id, status: 'changed', changedFields: fields });
    else unchanged.push(id);
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort((p, q) => (p.memberId < q.memberId ? -1 : p.memberId > q.memberId ? 1 : 0)),
    unchanged: unchanged.sort(),
  };
}

/** True iff anything changed (added, removed, or edited) between the two states. */
export function hasBoardChanges(diff: BoardStateDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}
