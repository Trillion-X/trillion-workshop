// packages/group/read-data/selection-algebra.test.ts
//
// Proves the selection set-algebra: union/intersect/difference/symmetric-difference/complement (order-preserving,
// deduped, n-ary where noted), and the DATA-keyed applySetOp (each op by key + fail-safe no-op on unknown key).

import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { unionIds, intersectIds, differenceIds, symmetricDifferenceIds, complementIds, applySetOp } from '../../../read-data/selection-algebra.ts';

describe('unionIds', () => {
  it('first-seen order across all lists, deduped, n-ary', () => {
    expect(unionIds(['a', 'b'], ['b', 'c'], ['a', 'd'])).toEqual(['a', 'b', 'c', 'd']);
    expect(unionIds()).toEqual([]);
    expect(unionIds(['a', 'a', 'b'])).toEqual(['a', 'b']); // dedupes within a single list too
  });
});

describe('intersectIds', () => {
  it("keeps a's order; survives only if in every operand; n-ary", () => {
    expect(intersectIds(['a', 'b', 'c'], ['c', 'b'])).toEqual(['b', 'c']); // a's order, not b's
    expect(intersectIds(['a', 'b', 'c', 'd'], ['a', 'b', 'c'], ['b', 'c', 'e'])).toEqual(['b', 'c']);
    expect(intersectIds(['a', 'b'])).toEqual(['a', 'b']); // no rest → a deduped
    expect(intersectIds(['a', 'b'], ['x'])).toEqual([]);  // disjoint → empty
  });
});

describe('differenceIds', () => {
  it("a − b in a's order, deduped", () => {
    expect(differenceIds(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
    expect(differenceIds(['a', 'a', 'b'], [])).toEqual(['a', 'b']);
    expect(differenceIds(['a'], ['a', 'b'])).toEqual([]);
  });
});

describe('symmetricDifferenceIds', () => {
  it('ids in exactly one set: a-not-b then b-not-a', () => {
    expect(symmetricDifferenceIds(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['a', 'd']);
    expect(symmetricDifferenceIds(['a', 'b'], ['a', 'b'])).toEqual([]); // identical → empty
  });
});

describe('complementIds', () => {
  it('universe minus subset, universe order (invert over a known universe)', () => {
    expect(complementIds(['a', 'b', 'c', 'd'], ['b', 'd'])).toEqual(['a', 'c']);
    expect(complementIds(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

describe('applySetOp (DATA-keyed)', () => {
  const a = ['a', 'b', 'c'], b = ['b', 'c', 'd'];
  it('dispatches each op by string key', () => {
    expect(applySetOp('union', a, b)).toEqual(['a', 'b', 'c', 'd']);
    expect(applySetOp('intersect', a, b)).toEqual(['b', 'c']);
    expect(applySetOp('difference', a, b)).toEqual(['a']);
    expect(applySetOp('symmetric-difference', a, b)).toEqual(['a', 'd']);
  });
  it('unknown key → fail-safe no-op keeping the primary selection (deduped), never throws/empties', () => {
    expect(applySetOp('nope', ['a', 'a', 'b'], b)).toEqual(['a', 'b']);
  });
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('treats inherited key %s as an unknown operation', (op) => {
    expect(applySetOp(op, ['a', 'a', 'b'], b)).toEqual(['a', 'b']);
  });
});
