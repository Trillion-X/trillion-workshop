// Proof for cyclic list stepping: nextInCycle wraps forward/back, enters from the near end when there is no
// current id, and returns null only for an empty list.
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { nextInCycle } from '../../../read-data/cyclic-step.ts';

const IDS = ['a', 'b', 'c'];

describe('cyclic-step — nextInCycle', () => {
  it('steps forward and back from a member', () => {
    expect(nextInCycle(IDS, 'a', 1)).toBe('b');
    expect(nextInCycle(IDS, 'b', 1)).toBe('c');
    expect(nextInCycle(IDS, 'b', -1)).toBe('a');
  });

  it('wraps at both ends', () => {
    expect(nextInCycle(IDS, 'c', 1)).toBe('a'); // forward past the end → first
    expect(nextInCycle(IDS, 'a', -1)).toBe('c'); // back past the start → last
  });

  it('enters from the near end when there is no current id', () => {
    expect(nextInCycle(IDS, null, 1)).toBe('a'); // forward → first
    expect(nextInCycle(IDS, null, -1)).toBe('c'); // back → last
    expect(nextInCycle(IDS, undefined, 1)).toBe('a');
  });

  it('a current id not in the list is treated as "not on the list" (enters from the near end)', () => {
    expect(nextInCycle(IDS, 'zzz', 1)).toBe('a');
    expect(nextInCycle(IDS, 'zzz', -1)).toBe('c');
  });

  it('a single-element list returns that element for either direction', () => {
    expect(nextInCycle(['only'], 'only', 1)).toBe('only');
    expect(nextInCycle(['only'], 'only', -1)).toBe('only');
  });

  it('an empty list returns null', () => {
    expect(nextInCycle([], null, 1)).toBeNull();
    expect(nextInCycle([], 'a', -1)).toBeNull();
  });
});
