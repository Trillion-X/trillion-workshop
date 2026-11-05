// packages/group/read-data/board-diff.test.ts
import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { deepEqual, changedFieldsBetween, diffBoardStates, hasBoardChanges } from '../../../read-data/board-diff.ts';
import type { BoardState } from '../../../read-data/board-merge.ts';

describe('deepEqual', () => {
  it('primitives by identity', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual(NaN, NaN)).toBe(false); // === semantics — a real change, never a silent match
  });
  it('arrays element-wise + length', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false); // order-sensitive
  });
  it('plain objects by keys (order-independent) + nested', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: { x: [1, 2] } }, { a: { x: [1, 2] } })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false); // extra key
    expect(deepEqual({ a: { x: 1 } }, { a: { x: 2 } })).toBe(false);
  });
  it('array vs object are never equal', () => {
    expect(deepEqual([], {})).toBe(false);
  });
});

describe('changedFieldsBetween', () => {
  it('returns the sorted keys whose value differs (union of both members)', () => {
    expect(changedFieldsBetween({ x: 1, y: 2, text: 'a' }, { x: 9, y: 2, text: 'a' })).toEqual(['x']);
    expect(changedFieldsBetween({ x: 1, text: 'a' }, { x: 1, text: 'b' })).toEqual(['text']);
  });
  it('a field present on one side only counts as changed', () => {
    expect(changedFieldsBetween({ x: 1 }, { x: 1, extra: { c: 'red' } })).toEqual(['extra']);
    expect(changedFieldsBetween({ x: 1, parent: 's1' }, { x: 1 })).toEqual(['parent']);
  });
  it('deep object equality does not report a false change', () => {
    expect(changedFieldsBetween({ extra: { marker: '*' } }, { extra: { marker: '*' } })).toEqual([]);
  });
});

describe('diffBoardStates', () => {
  const before: BoardState = {
    a: { kind: 'note', x: 0, y: 0, text: 'Alpha' },
    b: { kind: 'note', x: 10, y: 0, text: 'Beta' },
    c: { kind: 'note', x: 20, y: 0, text: 'Gamma' },
  };
  const after: BoardState = {
    a: { kind: 'note', x: 0, y: 0, text: 'Alpha' }, // unchanged
    b: { kind: 'note', x: 99, y: 0, text: 'Beta' }, // moved (x)
    d: { kind: 'note', x: 30, y: 0, text: 'Delta' }, // added
    // c removed
  };
  it('classifies added / removed / changed / unchanged (all sorted)', () => {
    const diff = diffBoardStates(before, after);
    expect(diff.added).toEqual(['d']);
    expect(diff.removed).toEqual(['c']);
    expect(diff.changed).toEqual([{ memberId: 'b', status: 'changed', changedFields: ['x'] }]);
    expect(diff.unchanged).toEqual(['a']);
  });
  it('identical states → no changes', () => {
    const diff = diffBoardStates(before, before);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toEqual(['a', 'b', 'c']);
    expect(hasBoardChanges(diff)).toBe(false);
  });
  it('hasBoardChanges true when anything differs', () => {
    expect(hasBoardChanges(diffBoardStates(before, after))).toBe(true);
  });
  it('changed members are sorted by id', () => {
    const b1: BoardState = { z: { v: 1 }, a: { v: 1 } };
    const b2: BoardState = { z: { v: 2 }, a: { v: 2 } };
    expect(diffBoardStates(b1, b2).changed.map((c) => c.memberId)).toEqual(['a', 'z']);
  });
});
