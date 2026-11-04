// packages/group/read-data/board-merge.test.ts
import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  DELETED_FIELD,
  liveMembers,
  maxLamport,
  mergeOps,
  nextLamport,
  type FieldOp,
} from '../../../read-data/board-merge.ts';

const op = (memberId: string, field: string, value: unknown, lamport: number, actorId: string): FieldOp => ({
  memberId,
  field,
  value,
  lamport,
  actorId,
});

// Deterministic shuffle (index-seeded) — no Math.random (banned in this codebase).
function shuffle<T>(arr: readonly T[], seed: number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = (i * 2654435761 + seed) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

describe('mergeOps — convergence', () => {
  it('concurrent writes to the same field pick a stable winner by (lamport, actorId)', () => {
    const ops = [op('m1', 'text', 'from-alice', 5, 'alice'), op('m1', 'text', 'from-bob', 5, 'bob')];
    // equal lamport → higher actorId ('bob' > 'alice') wins, regardless of order
    expect(mergeOps(ops).m1.text).toBe('from-bob');
    expect(mergeOps([...ops].reverse()).m1.text).toBe('from-bob');
  });

  it('higher lamport always wins', () => {
    const ops = [op('m1', 'x', 1, 9, 'alice'), op('m1', 'x', 2, 3, 'zed')];
    expect(mergeOps(ops).m1.x).toBe(1); // lamport 9 > 3, even though 'zed' > 'alice'
  });

  it('writes to different fields of the same member both survive', () => {
    const ops = [op('m1', 'x', 10, 1, 'a'), op('m1', 'y', 20, 1, 'b')];
    expect(mergeOps(ops).m1).toEqual({ x: 10, y: 20 });
  });

  it('a separator character in an id/field cannot collide two distinct (member, field) pairs', () => {
    // With ANY single-string key `${member}<sep>${field}`, member "a<sep>b"+field "c" and member "a"+field
    // "b<sep>c" would collide and clobber one another. The nested map keeps both. Tested with a NUL byte
    // (the most "unlikely" separator) AND a space to lock the property for any character.
    for (const sep of ['\0', ' ']) {
      const state = mergeOps([
        op(`a${sep}b`, 'c', 1, 1, 'x'),
        op('a', `b${sep}c`, 2, 2, 'y'),
      ]);
      expect(state[`a${sep}b`]).toEqual({ c: 1 }); // distinct member survives
      expect(state.a).toEqual({ [`b${sep}c`]: 2 }); // distinct (member, field) survives
    }
  });

  it('is order-independent — every permutation converges to the same state', () => {
    const ops = [
      op('m1', 'text', 'a1', 1, 'a'),
      op('m1', 'text', 'b1', 2, 'b'),
      op('m2', 'color', 'red', 1, 'a'),
      op('m2', 'color', 'blue', 1, 'b'),
      op('m1', 'x', 5, 3, 'a'),
    ];
    const base = mergeOps(ops);
    for (let seed = 1; seed <= 6; seed++) {
      expect(mergeOps(shuffle(ops, seed))).toEqual(base);
    }
    expect(base).toEqual({ m1: { text: 'b1', x: 5 }, m2: { color: 'blue' } });
  });
});

describe('mergeOps — delete as a LWW field (no special case)', () => {
  it('a delete op tombstones the member', () => {
    const ops = [op('m1', 'text', 'hi', 1, 'a'), op('m1', DELETED_FIELD, true, 2, 'a')];
    expect(mergeOps(ops).m1[DELETED_FIELD]).toBe(true);
    expect(liveMembers(mergeOps(ops))).toEqual([]);
  });

  it('a later un-delete (higher lamport) revives the member', () => {
    const ops = [op('m1', DELETED_FIELD, true, 2, 'a'), op('m1', DELETED_FIELD, false, 5, 'b')];
    expect(liveMembers(mergeOps(ops))).toEqual(['m1']);
  });

  it('delete-vs-edit race resolves by the LWW order (edit after delete wins)', () => {
    const ops = [op('m1', DELETED_FIELD, true, 3, 'a'), op('m1', DELETED_FIELD, false, 4, 'b'), op('m1', 'text', 'edited', 4, 'b')];
    const s = mergeOps(ops);
    expect(liveMembers(s)).toEqual(['m1']);
    expect(s.m1.text).toBe('edited');
  });
});

describe('lamport clock', () => {
  it('nextLamport ticks past the observed max', () => {
    const ops = [op('m', 'x', 1, 4, 'a'), op('m', 'y', 2, 7, 'b')];
    expect(maxLamport(ops)).toBe(7);
    expect(nextLamport(maxLamport(ops))).toBe(8);
  });
});

describe('board-merge — untrusted FieldOp keys cannot prototype-pollute the merged state (cont.98 batch-21)', () => {
  // A malicious multiplayer peer can send any string as op.field / op.memberId. On a plain-{} accumulator,
  // field '__proto__' with an object value REASSIGNS the member state's [[Prototype]], so liveMembers reads
  // an INHERITED __deleted:true and falsely tombstones a live member (CRDT corruption). Null-proto maps make
  // every untrusted key a plain own field. (Transport latent today; the boundary is hardened before wiring.)
  it("field '__proto__' with a {__deleted:true} value does NOT falsely tombstone the member", () => {
    const state = mergeOps([
      op('m1', 'text', 'hello', 1, 'a'),
      op('m1', '__proto__', { [DELETED_FIELD]: true }, 2, 'a'), // hostile: try to inject inherited __deleted
    ]);
    // m1 is NOT deleted — the '__proto__' op is a plain own field, not a prototype reassignment.
    expect(liveMembers(state)).toEqual(['m1']);
    expect(state['m1'][DELETED_FIELD]).not.toBe(true); // no inherited tombstone
    expect(state['m1'].text).toBe('hello'); // real field survives
  });

  it("memberId '__proto__' is a real member key, not a prototype reassignment", () => {
    const state = mergeOps([
      op('__proto__', 'text', 'x', 1, 'a'),
      op('real', 'text', 'y', 1, 'a'),
    ]);
    expect(liveMembers(state).sort()).toEqual(['__proto__', 'real']); // the '__proto__' member is visible, not dropped
    expect(state['__proto__'].text).toBe('x');
  });

  it("a genuine __deleted op still tombstones (real delete unaffected)", () => {
    const state = mergeOps([
      op('m2', 'text', 'v', 1, 'a'),
      op('m2', DELETED_FIELD, true, 2, 'a'),
    ]);
    expect(liveMembers(state)).toEqual([]); // m2 correctly tombstoned via a real field op
  });
});
