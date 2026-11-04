// packages/group/do-work/frequency-tally.test.ts
import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  frequencyTally,
  tallyToRanked,
  frequencyScale,
  countRange,
} from '../../../do-work/frequency-tally.ts';

describe('frequencyTally', () => {
  it('counts occurrences, skips empty/non-string', () => {
    const t = frequencyTally(['a', 'b', 'a', 'a', 'b', '', 'c']);
    expect(t.get('a')).toBe(3);
    expect(t.get('b')).toBe(2);
    expect(t.get('c')).toBe(1);
    expect(t.has('')).toBe(false);
  });
  it('empty input → empty tally', () => {
    expect(frequencyTally([]).size).toBe(0);
  });
});

describe('tallyToRanked', () => {
  it('sorts by count desc, ties keep first-seen order', () => {
    const t = frequencyTally(['x', 'y', 'z', 'y', 'x', 'x']); // x:3, y:2, z:1
    expect(tallyToRanked(t).map((r) => r.value)).toEqual(['x', 'y', 'z']);
  });
  it('ties broken by first appearance (stable)', () => {
    const t = frequencyTally(['b', 'a', 'a', 'b']); // both 2; b seen first
    expect(tallyToRanked(t).map((r) => r.value)).toEqual(['b', 'a']);
  });
  it('limit keeps the top-N', () => {
    const t = frequencyTally(['a', 'a', 'a', 'b', 'b', 'c']);
    expect(tallyToRanked(t, { limit: 2 }).map((r) => r.value)).toEqual(['a', 'b']);
  });
});

describe('frequencyScale', () => {
  it('maps min count → minSize, max count → maxSize', () => {
    expect(frequencyScale(1, { minCount: 1, maxCount: 9, minSize: 12, maxSize: 40, scale: 'linear' })).toBe(12);
    expect(frequencyScale(9, { minCount: 1, maxCount: 9, minSize: 12, maxSize: 40, scale: 'linear' })).toBe(40);
  });
  it('linear midpoint is proportional', () => {
    expect(frequencyScale(5, { minCount: 1, maxCount: 9, minSize: 10, maxSize: 50, scale: 'linear' })).toBe(30);
  });
  it('all-equal counts → every value gets maxSize (range 0, no div-by-zero)', () => {
    expect(frequencyScale(4, { minCount: 4, maxCount: 4, minSize: 12, maxSize: 40 })).toBe(40);
  });
  it('sqrt/log compress the tail vs linear (a mid count sizes LARGER under sqrt)', () => {
    const lin = frequencyScale(2, { minCount: 1, maxCount: 100, minSize: 10, maxSize: 50, scale: 'linear' });
    const sq = frequencyScale(2, { minCount: 1, maxCount: 100, minSize: 10, maxSize: 50, scale: 'sqrt' });
    const lg = frequencyScale(2, { minCount: 1, maxCount: 100, minSize: 10, maxSize: 50, scale: 'log' });
    expect(sq).toBeGreaterThan(lin); // damping lifts small counts
    expect(lg).toBeGreaterThan(sq);
  });
  it('clamps out-of-range counts and non-finite → minSize', () => {
    expect(frequencyScale(50, { minCount: 1, maxCount: 9, minSize: 12, maxSize: 40, scale: 'linear' })).toBe(40);
    expect(frequencyScale(NaN, { minCount: 1, maxCount: 9 })).toBe(12);
  });
});

describe('countRange', () => {
  it('min/max of a tally; empty → {0,0}', () => {
    expect(countRange(frequencyTally(['a', 'a', 'b']))).toEqual({ min: 1, max: 2 });
    expect(countRange(new Map())).toEqual({ min: 0, max: 0 });
  });
});
