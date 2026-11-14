// packages/group/show/InsightsMenu.grouping.test.ts
//
// Unit coverage for the b217 InsightsMenu grouping fold + the L118 header gate. The Chromium harness
// (proof/2026-07-09-render-grouped-insights.mjs) proves the rendered DOM for one board; these tests prove the
// pure fold logic across the edge cases a single harness can't cheaply cover: order preservation, ungrouped
// collection, mixed grouped+ungrouped, and the exact "> 1 named group" header rule the component renders from.
import { describe, it, expect } from 'vitest';
import { groupLenses, namedGroupCount, type InsightLens } from './InsightsMenu';

// A lens's render is irrelevant to the fold — stub it so we can build lenses in a plain .ts test.
const lens = (key: string, group?: string): InsightLens => ({
  key,
  label: key,
  available: true,
  group,
  render: (() => null) as unknown as InsightLens['render'],
});

describe('groupLenses — the b217 grouping fold', () => {
  it('folds by declared group, preserving first-seen group order and within-group declared order', () => {
    const folded = groupLenses([
      lens('due', 'Deadlines'),
      lens('review', 'Momentum'),
      lens('agenda', 'Deadlines'), // re-enters the earlier Deadlines bucket, does NOT create a new one
      lens('progress', 'Momentum'),
    ]);
    expect(folded.map((g) => g.group)).toEqual(['Deadlines', 'Momentum']); // first-seen order
    expect(folded[0].lenses.map((l) => l.key)).toEqual(['due', 'agenda']); // within-group declared order
    expect(folded[1].lenses.map((l) => l.key)).toEqual(['review', 'progress']);
  });

  it('collects ungrouped lenses under the empty-string bucket', () => {
    const folded = groupLenses([lens('a', 'G1'), lens('b'), lens('c', 'G1'), lens('d')]);
    const empty = folded.find((g) => g.group === '');
    expect(empty).toBeDefined();
    expect(empty!.lenses.map((l) => l.key)).toEqual(['b', 'd']);
    expect(folded.find((g) => g.group === 'G1')!.lenses.map((l) => l.key)).toEqual(['a', 'c']);
  });

  it('returns one bucket with the empty group when NO lens declares a group', () => {
    const folded = groupLenses([lens('a'), lens('b')]);
    expect(folded).toHaveLength(1);
    expect(folded[0].group).toBe('');
    expect(namedGroupCount(folded)).toBe(0);
  });
});

describe('namedGroupCount — the L118 header gate the menu renders from', () => {
  it('counts only NON-empty groups (the ungrouped bucket never adds a header)', () => {
    expect(namedGroupCount(groupLenses([lens('a', 'G1'), lens('b', 'G2'), lens('c')]))).toBe(2);
  });

  it('is > 1 (headers shown) only with multiple named groups; <= 1 stays flat', () => {
    // multiple named groups -> headers
    expect(namedGroupCount(groupLenses([lens('a', 'G1'), lens('b', 'G2')])) > 1).toBe(true);
    // single named group -> flat (no headers), even with several lenses in it
    expect(namedGroupCount(groupLenses([lens('a', 'G1'), lens('b', 'G1'), lens('c', 'G1')])) > 1).toBe(false);
    // ungrouped -> flat
    expect(namedGroupCount(groupLenses([lens('a'), lens('b')])) > 1).toBe(false);
    // one named group + ungrouped -> still one named group -> flat
    expect(namedGroupCount(groupLenses([lens('a', 'G1'), lens('b')])) > 1).toBe(false);
  });
});
