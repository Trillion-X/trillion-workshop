// packages/group/read-data/board-crosstab.test.ts
//
// Proves b177's cross-tab: 2-D contingency counts + the measure-aggregate mode, marginals, multi-value axes,
// dense grid + ordering, the NUL key (no space-collision), cell() lookup, and the markdown table renderer.

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import { crossTab, cell, crossTabText } from './board-crosstab';
import type { FacetExtract } from './board-facet-census';
import { aggregatorById, type BoardMeasure } from './board-facet-pivot';

// a card carries its own row values, col values, and a numeric score
function card(memberId: string, rows: string[], cols: string[], score: number | null = null): BoardItem {
  return { memberId, kind: 'note', x: 0, y: 0, w: 100, h: 40, text: '', extra: { rows, cols, score }, isSection: false } as unknown as BoardItem;
}
const connector = (memberId: string): BoardItem =>
  ({ memberId, kind: 'note', x: 0, y: 0, w: 4, h: 4, extra: { fromMemberId: 'a', toMemberId: 'b' }, isSection: false } as unknown as BoardItem);
const rowFacet: FacetExtract = (i) => ((i.extra as { rows?: string[] }).rows ?? []);
const colFacet: FacetExtract = (i) => ((i.extra as { cols?: string[] }).cols ?? []);
const scoreOf: BoardMeasure = (i) => {
  const s = (i.extra as { score?: number | null }).score;
  return typeof s === 'number' ? s : null;
};

describe('crossTab — count mode (contingency table)', () => {
  const board: BoardItem[] = [
    card('a', ['design'], ['red']),
    card('b', ['design'], ['blue']),
    card('c', ['urgent'], ['red']),
    card('d', ['design', 'urgent'], ['red']), // multi-row: lands in design×red AND urgent×red
    connector('e1'),
  ];

  it('counts cards per (row,col), dense grid, marginals, ordering by total desc', () => {
    const t = crossTab(board, rowFacet, colFacet);
    expect(t.rows).toEqual(['design', 'urgent']); // design 3 cards > urgent 2
    expect(t.cols).toEqual(['red', 'blue']);       // red 3 > blue 1
    expect(t.cells).toHaveLength(4);               // 2 rows × 2 cols, dense
    expect(cell(t, 'design', 'red')?.count).toBe(2);  // a, d
    expect(cell(t, 'design', 'blue')?.count).toBe(1); // b
    expect(cell(t, 'urgent', 'red')?.count).toBe(2);  // c, d (d is design+urgent)
    expect(cell(t, 'urgent', 'blue')?.count).toBe(0); // dense zero cell
    expect(cell(t, 'design', 'red')?.value).toBe(2);  // value === count in count mode
  });

  it('marginals count a card once per axis value; total is distinct cards', () => {
    const t = crossTab(board, rowFacet, colFacet);
    expect(t.rowTotals.get('design')).toBe(3); // a,b,d
    expect(t.rowTotals.get('urgent')).toBe(2);  // c,d
    expect(t.colTotals.get('red')).toBe(3);     // a,c,d
    expect(t.total).toBe(4);                    // a,b,c,d distinct (connector excluded)
  });
});

describe('crossTab — measure-aggregate mode', () => {
  const board = [
    card('a', ['x'], ['p'], 4),
    card('b', ['x'], ['p'], 10),
    card('c', ['x'], ['q'], null), // no measure
  ];
  it('a cell holds the aggregate over measured values; unmeasured cell → null (never fake 0)', () => {
    const t = crossTab(board, rowFacet, colFacet, scoreOf, aggregatorById('mean')!);
    expect(cell(t, 'x', 'p')).toMatchObject({ count: 2, measured: 2, value: 7 });   // mean(4,10)
    expect(cell(t, 'x', 'q')).toMatchObject({ count: 1, measured: 0, value: null }); // present but unmeasured
    // a different aggregator over the same cell gives a different value (max(4,10)=10)
    const tMax = crossTab(board, rowFacet, colFacet, scoreOf, aggregatorById('max')!);
    expect(cell(tMax, 'x', 'p')?.value).toBe(10);
  });
});

describe('crossTab — key safety + empties', () => {
  it('a value containing a space does not collide with another pair (NUL key, b168 lesson)', () => {
    const board = [card('a', ['a b'], ['c']), card('b', ['a'], ['b c'])];
    const t = crossTab(board, rowFacet, colFacet);
    // if the key used a space, "a b"+"c" and "a"+"b c" would both be "a b c" and collapse to one cell
    expect(cell(t, 'a b', 'c')?.count).toBe(1);
    expect(cell(t, 'a', 'b c')?.count).toBe(1);
    expect(t.total).toBe(2);
  });
  it('a card missing either axis is skipped; empty board → empty tab', () => {
    expect(crossTab([card('a', [], ['p'])], rowFacet, colFacet).total).toBe(0);
    expect(crossTab([], rowFacet, colFacet)).toMatchObject({ rows: [], cols: [], total: 0 });
    expect(cell(crossTab([], rowFacet, colFacet), 'x', 'y')).toBeNull();
  });
});

describe('crossTabText', () => {
  it('renders a markdown table with a header, cells, and marginal totals', () => {
    const board = [card('a', ['design'], ['red']), card('b', ['design'], ['blue']), card('c', ['urgent'], ['red'])];
    const txt = crossTabText(board, rowFacet, colFacet, 'Tag × colour');
    expect(txt).toBe(
      '## Tag × colour\n\n' +
      '| | red | blue | **Total** |\n' +
      '| --- | --- | --- | --- |\n' +
      '| **design** | 1 | 1 | 2 |\n' +
      '| **urgent** | 1 | 0 | 1 |\n' +
      '| **Total** | 2 | 1 | 3 |',
    );
  });
  it('a null cell (measure mode, no card) renders ·; empty → _none_', () => {
    const board = [card('a', ['x'], ['p'], 5), card('b', ['x'], ['q'], null)];
    const txt = crossTabText(board, rowFacet, colFacet, 'Scores', { measure: scoreOf, agg: aggregatorById('mean')! });
    expect(txt).toContain('| **x** | 5 | · | 2 |');
    expect(crossTabText([], rowFacet, colFacet, 'Empty')).toBe('## Empty\n\n_none_');
  });
});
