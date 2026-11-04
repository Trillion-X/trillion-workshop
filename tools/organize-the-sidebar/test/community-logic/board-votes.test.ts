// Vendored unchanged except for import paths from bitfield-packages/packages/group/read-data/board-votes.test.ts.
// Proof for the vote-tally primitive: fail-closed normalize, cast/retract clamping, per-actor budget,
// and rank-by-votes.
import { describe, expect, it } from '../../../match-community-members/test/vitest-shim.mjs';
import {
  type TalliedItem,
  actorBudgetRemaining,
  actorBudgetUsed,
  actorVotes,
  castVote,
  clearActor,
  rankByVotes,
  tallyFromRaw,
  totalVotes,
  voteCount,
  voterCount,
} from '../../read-data/board-votes.ts';

describe('board-votes — the vote-tally primitive', () => {
  it('tallyFromRaw is fail-closed: non-object → {}, only string→positive-int entries kept', () => {
    expect(tallyFromRaw(undefined)).toEqual({});
    expect(tallyFromRaw('x')).toEqual({});
    expect(tallyFromRaw({ a: 2, b: 0, c: -1, d: 1.5, e: 'z', f: 3 })).toEqual({ a: 2, f: 3 });
  });

  it('an ARRAY-shaped raw is rejected — no bogus index-keyed tally', () => {
    // `[2]` is typeof 'object'; Object.entries would turn index 0 into actor "0" with 2 dots. A tally is a
    // plain actor->count map, so an array must fail closed to {}, not fabricate a phantom voter.
    expect(tallyFromRaw([2])).toEqual({});
    expect(voteCount(tallyFromRaw([2, 5]))).toBe(0);
    expect(tallyFromRaw([])).toEqual({});
  });

  it('voteCount + voterCount + actorVotes read a tally', () => {
    const t = { alice: 3, bob: 1 };
    expect(voteCount(t)).toBe(4);
    expect(voterCount(t)).toBe(2);
    expect(actorVotes(t, 'alice')).toBe(3);
    expect(actorVotes(t, 'nobody')).toBe(0);
  });

  it('castVote adds/retracts, clamps at 0, and removes the key when it hits 0', () => {
    let t = castVote({}, 'me', 1);
    expect(t).toEqual({ me: 1 });
    t = castVote(t, 'me', 2);
    expect(t).toEqual({ me: 3 });
    t = castVote(t, 'me', -1);
    expect(t).toEqual({ me: 2 });
    t = castVote(t, 'me', -5); // clamp at 0 → key removed
    expect(t).toEqual({});
  });

  it('clearActor removes only that actor', () => {
    expect(clearActor({ a: 2, b: 1 }, 'a')).toEqual({ b: 1 });
    expect(clearActor({ b: 1 }, 'a')).toEqual({ b: 1 }); // absent → unchanged
  });

  it('per-actor budget: used across items, remaining never negative', () => {
    const items: TalliedItem[] = [
      { id: 'n1', tally: { me: 2, you: 1 } },
      { id: 'n2', tally: { me: 1 } },
      { id: 'n3', tally: {} },
    ];
    expect(actorBudgetUsed(items, 'me')).toBe(3);
    expect(actorBudgetUsed(items, 'you')).toBe(1);
    expect(actorBudgetRemaining(items, 'me', 5)).toBe(2);
    expect(actorBudgetRemaining(items, 'me', 2)).toBe(0); // over budget → 0, not negative
  });

  it('rankByVotes: most-voted first, unvoted excluded, stable ties; totalVotes sums all', () => {
    const items: TalliedItem[] = [
      { id: 'low', tally: { a: 1 } },
      { id: 'high', tally: { a: 2, b: 2 } },
      { id: 'zero', tally: {} },
      { id: 'mid', tally: { c: 2 } },
    ];
    expect(rankByVotes(items).map((r) => r.id)).toEqual(['high', 'mid', 'low']); // 4, 2, 1; zero excluded
    expect(rankByVotes(items).map((r) => r.count)).toEqual([4, 2, 1]);
    expect(totalVotes(items)).toBe(7);
  });
});

describe('board-votes — tallyFromRaw is proto-safe: no inherited-value lookup / phantom (cont.98 batch-20)', () => {
  // Defense at the untrusted ingest boundary (extra.votes). On a plain {} accumulator, actorVotes for an
  // absent actor named like a prototype member returned an inherited value (Object.prototype / a function)
  // instead of 0. The null-proto accumulator makes every absent-actor lookup cleanly 0.
  it('actorVotes for a prototype-named actor absent from the tally is 0 (not a function/Object)', () => {
    const tally = tallyFromRaw({ me: 2 });
    for (const proto of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf']) {
      expect(actorVotes(tally, proto)).toBe(0);
    }
    expect(actorVotes(tally, 'me')).toBe(2); // real actor still resolves
    expect(voterCount(tally)).toBe(1); // no phantom voters
  });
  it('a real numeric vote under a prototype-like key is preserved as a plain actor, not dropped/inherited', () => {
    // JSON.parse creates a genuine OWN '__proto__' data property (an object literal would special-case it).
    const tally = tallyFromRaw(JSON.parse('{"__proto__":3,"real":1}'));
    expect(actorVotes(tally, '__proto__')).toBe(3); // stored as an own key on the null-proto map (a plain {} would have dropped it)
    expect(voteCount(tally)).toBe(4);
  });
});
