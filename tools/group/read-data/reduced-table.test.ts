// packages/group/read-data/reduced-table.test.ts
//
// Proves the reducer-family READABLE shape (reduced-table.ts): the census→table adapter builds one SECTION per
// injected facet dimension that has ≥2 values, each GROUP carrying the exact cards it holds (so a blind panel
// can turn every group into a click-to-select control), and skips single-value / empty dimensions. Uses
// hand-injected extractors so the math is readable and catalog-independent (the deletion test: the adapter
// names no facet — a different extractor set reduces identically).

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import {
  censusReducedTable,
  reducedTableIsEmpty,
  reducedTableGroupCount,
  type LabeledFacet,
} from './reduced-table';

function card(memberId: string, extra: Record<string, unknown> = {}): BoardItem {
  return { memberId, kind: 'note', address: { boardId: 'b', memberId }, position: { x: 0, y: 0 }, extra } as unknown as BoardItem;
}

// Two toy dimensions injected by hand — the adapter reads only these, it names neither.
const tag: LabeledFacet = { key: 'tag', title: 'Tag', extract: (i) => (i.extra?.tags as string[] | undefined) ?? [] };
const color: LabeledFacet = { key: 'color', title: 'Color', extract: (i) => (i.extra?.color as string[] | undefined) ?? [] };

const items = [
  card('a', { tags: ['design', 'urgent'], color: ['red'] }),
  card('b', { tags: ['design'], color: ['red'] }),
  card('c', { tags: ['idea'], color: ['blue'] }),
];

describe('censusReducedTable — census as an interactive breakdown', () => {
  it('builds one section per facet, groups most-cards-first with the exact card ids', () => {
    const table = censusReducedTable(items, [tag, color]);
    expect(table.sections.map((s) => ({ key: s.key, title: s.title }))).toEqual([
      { key: 'tag', title: 'Tag' },
      { key: 'color', title: 'Color' },
    ]);
    // Tag: design(2) before idea(1) before urgent(1) — count desc, then value A→Z (census sort).
    expect(table.sections[0].groups).toEqual([
      { key: 'tag:design', label: 'design', detail: '2', cardIds: ['a', 'b'] },
      { key: 'tag:idea', label: 'idea', detail: '1', cardIds: ['c'] },
      { key: 'tag:urgent', label: 'urgent', detail: '1', cardIds: ['a'] },
    ]);
    // Color: red(2) before blue(1).
    expect(table.sections[1].groups.map((g) => `${g.label}=${g.detail}`)).toEqual(['red=2', 'blue=1']);
  });

  it('skips a dimension with fewer than 2 values (a constant is not a breakdown)', () => {
    // Every card is one colour → the Color facet has a single value → no Color section; Tag still varies.
    const oneColor = [card('a', { tags: ['x', 'y'], color: ['red'] }), card('b', { tags: ['y'], color: ['red'] })];
    const table = censusReducedTable(oneColor, [tag, color]);
    expect(table.sections.map((s) => s.key)).toEqual(['tag']); // color skipped (single value)
  });

  it('is empty when no dimension has ≥2 values', () => {
    const flat = [card('a'), card('b'), card('c')]; // no tags, no colour → both facets empty
    const table = censusReducedTable(flat, [tag, color]);
    expect(reducedTableIsEmpty(table)).toBe(true);
    expect(table.sections).toHaveLength(0);
    expect(censusReducedTable([], [tag, color]).sections).toHaveLength(0); // empty board
  });

  it('reducedTableGroupCount totals the clickable rows across sections', () => {
    const table = censusReducedTable(items, [tag, color]);
    expect(reducedTableGroupCount(table)).toBe(5); // 3 tag groups + 2 colour groups
    expect(reducedTableGroupCount({ sections: [] })).toBe(0);
  });

  it('the deletion test — a completely different injected facet set reduces through the SAME adapter', () => {
    const priority: LabeledFacet = { key: 'pri', title: 'Priority', extract: (i) => (i.extra?.pri as string[] | undefined) ?? [] };
    const rows = [card('a', { pri: ['hi'] }), card('b', { pri: ['hi'] }), card('c', { pri: ['lo'] })];
    const table = censusReducedTable(rows, [priority]);
    expect(table.sections).toHaveLength(1);
    expect(table.sections[0].groups.map((g) => `${g.label}:${g.cardIds.join(',')}`)).toEqual(['hi:a,b', 'lo:c']);
  });
});
