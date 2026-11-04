// packages/group/read-data/outline-filter.test.ts
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { matchingRows, visibleUnderFilter } from '../../../read-data/outline-filter.ts';
import type { ListItem } from '../../../read-data/list-block-model.ts';

const row = (id: string, indent: number, text: string): ListItem => ({ id, indent, text });
// Launch plan > (Draft the copy, Design the page > Pick the hero image), Ship it
const tree: ListItem[] = [
  row('a', 0, 'Launch plan'),
  row('b', 1, 'Draft the copy'),
  row('c', 1, 'Design the page'),
  row('d', 2, 'Pick the hero image'),
  row('e', 0, 'Ship it'),
];
const ids = (items: readonly ListItem[]) => items.map((i) => i.id);

describe('matchingRows — case-insensitive text match', () => {
  it('matches by substring, case-insensitive', () => {
    expect([...matchingRows(tree, 'design')]).toEqual(['c']);
    expect([...matchingRows(tree, 'THE')].sort()).toEqual(['b', 'c', 'd']); // "the" in three rows
  });
  it('empty / whitespace query → no matches', () => {
    expect(matchingRows(tree, '').size).toBe(0);
    expect(matchingRows(tree, '   ').size).toBe(0);
  });
});

describe('visibleUnderFilter — matches + ancestor context', () => {
  it('empty query → identity (all rows, original order)', () => {
    expect(ids(visibleUnderFilter(tree, ''))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('a matched deep child keeps its whole ancestor chain', () => {
    // "hero" matches only d (indent 2) → show d + its ancestors c (indent1) + a (indent0)
    expect(ids(visibleUnderFilter(tree, 'hero'))).toEqual(['a', 'c', 'd']);
  });

  it('a matched top-level row shows alone (no ancestors, no descendants)', () => {
    expect(ids(visibleUnderFilter(tree, 'ship'))).toEqual(['e']);
  });

  it('multiple matches union their ancestor paths, order preserved', () => {
    // "the" matches b, c, d → keep them + ancestors: a (of all), c (ancestor of d, also a match)
    expect(ids(visibleUnderFilter(tree, 'the'))).toEqual(['a', 'b', 'c', 'd']); // e (Ship it) excluded
  });

  it('no match → empty (honest)', () => {
    expect(visibleUnderFilter(tree, 'zzz')).toEqual([]);
  });

  it('a matched parent does NOT pull in non-matching children', () => {
    // "plan" matches only a; its children b/c/d don't match → only a shows
    expect(ids(visibleUnderFilter(tree, 'plan'))).toEqual(['a']);
  });
});
