// packages/group/show/selection-combine.test.ts
//
// Proves the combine model: COMBINE_ACTIONS carry the human labels over the b187 op keys, and combineWithPinned
// applies current-vs-pinned correctly (current is the primary operand) via each op.

import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { COMBINE_ACTIONS, combineWithPinned } from '../../../show/selection-combine.ts';

describe('COMBINE_ACTIONS', () => {
  it('maps the four set ops to human labels', () => {
    expect(COMBINE_ACTIONS.map((a) => a.op)).toEqual(['union', 'intersect', 'difference', 'symmetric-difference']);
    expect(COMBINE_ACTIONS.find((a) => a.op === 'intersect')!.label).toBe('Keep in both');
    expect(COMBINE_ACTIONS.find((a) => a.op === 'difference')!.label).toBe('Remove pinned');
  });
});

describe('combineWithPinned (current is the primary operand)', () => {
  const current = ['b', 'c', 'd'];
  const pinned = ['a', 'b', 'c'];
  it('union / intersect / difference / symmetric-difference', () => {
    expect(combineWithPinned(current, pinned, 'union')).toEqual(['b', 'c', 'd', 'a']); // current-first order
    expect(combineWithPinned(current, pinned, 'intersect')).toEqual(['b', 'c']);
    expect(combineWithPinned(current, pinned, 'difference')).toEqual(['d']); // current − pinned
    expect(combineWithPinned(current, pinned, 'symmetric-difference')).toEqual(['d', 'a']);
  });
  it('unknown op keeps the current selection (fail-safe, deduped)', () => {
    expect(combineWithPinned(['b', 'b', 'c'], pinned, 'nope')).toEqual(['b', 'c']);
  });
});
