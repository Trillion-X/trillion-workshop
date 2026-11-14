// packages/group/read-data/board-reading-order.test.ts
//
// Proves b167 on two levels: (1) the generative kernel `bandCluster` (1D gap clustering) with exact readable
// math + the L069 deletion test (band by a DIFFERENT accessor — a column read, or a price field — zero engine
// change); (2) `readingOrder` — row bands top→bottom, left→right within a row, connectors/furniture excluded.

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import {
  bandCluster,
  readingOrder,
  readingIndexOf,
  boardHasReadingOrder,
  readingOrderText,
} from './board-reading-order';

function card(memberId: string, x: number, y: number, text = memberId, w = 100, h = 40): BoardItem {
  return { memberId, kind: 'note', x, y, w, h, text, extra: {} } as unknown as BoardItem;
}
function connector(memberId: string, from: string, to: string): BoardItem {
  return { memberId, kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem;
}
function region(memberId: string, x: number, y: number): BoardItem {
  return { memberId, kind: 'note', x, y, w: 100, h: 40, extra: { regionHeading: true } } as unknown as BoardItem;
}

describe('bandCluster — the 1D gap-clustering kernel', () => {
  const num = (n: number) => ({ n });
  const valueOf = (o: { n: number }) => o.n;

  it('splits into bands wherever the gap exceeds the tolerance; each band value-ascending', () => {
    const vals = [num(0), num(5), num(50), num(52), num(100)];
    const bands = bandCluster(vals, valueOf, 10).map((b) => b.map(valueOf));
    expect(bands).toEqual([[0, 5], [50, 52], [100]]); // 5→50 and 52→100 exceed 10
  });

  it('tolerance 0 groups only exact ties', () => {
    const vals = [num(1), num(1), num(2)];
    expect(bandCluster(vals, valueOf, 0).map((b) => b.map(valueOf))).toEqual([[1, 1], [2]]);
  });

  it('a huge tolerance is one band; empty is no bands', () => {
    expect(bandCluster([num(1), num(9)], valueOf, 1000).map((b) => b.map(valueOf))).toEqual([[1, 9]]);
    expect(bandCluster([], valueOf, 5)).toEqual([]);
  });

  it('non-finite tolerance falls back to 0 (exact ties)', () => {
    expect(bandCluster([num(1), num(2)], valueOf, NaN).map((b) => b.map(valueOf))).toEqual([[1], [2]]);
  });

  it('DELETION TEST: the SAME kernel bands by a never-coded accessor (price) with zero engine change', () => {
    const priced = [{ price: 3 }, { price: 4 }, { price: 40 }];
    const bands = bandCluster(priced, (p) => p.price, 5).map((b) => b.map((p) => p.price));
    expect(bands).toEqual([[3, 4], [40]]);
  });
});

describe('readingOrder — row bands top→bottom, left→right within a row', () => {
  // Row 1 (y≈0): b(x=200), a(x=0), c(x=100) → reads a,c,b.  Row 2 (y≈200): d(x=50), e(x=150) → d,e.
  const items = [
    card('b', 200, 0), card('a', 0, 0), card('c', 100, 0),
    card('d', 50, 200), card('e', 150, 200),
    connector('conn', 'a', 'b'),  // excluded
    region('reg', 0, 400),         // excluded
  ];

  it('orders rows top→bottom and cards left→right within a row', () => {
    expect(readingOrder(items)).toEqual(['a', 'c', 'b', 'd', 'e']);
  });

  it('excludes connectors and furniture', () => {
    expect(readingOrder(items)).not.toContain('conn');
    expect(readingOrder(items)).not.toContain('reg');
  });

  it('rowTolerance controls what counts as the same row', () => {
    // Two cards 30 apart vertically: default tol 40 → one row (left→right); tol 10 → two rows (top→bottom).
    const near = [card('lo', 100, 30), card('hi', 0, 0)];
    expect(readingOrder(near)).toEqual(['hi', 'lo']);              // same row → left→right (hi x=0 first)
    expect(readingOrder(near, { rowTolerance: 10 })).toEqual(['hi', 'lo']); // two rows → top(hi) then bottom(lo)
  });

  it('stable tie-break by x then memberId at the same point', () => {
    expect(readingOrder([card('z', 0, 0), card('a', 0, 0)])).toEqual(['a', 'z']);
  });

  it('readingIndexOf is 1-based; null for absent / non-content', () => {
    expect(readingIndexOf(items, 'b')).toBe(3);
    expect(readingIndexOf(items, 'a')).toBe(1);
    expect(readingIndexOf(items, 'conn')).toBeNull();
    expect(readingIndexOf(items, 'nope')).toBeNull();
  });

  it('boardHasReadingOrder / empty', () => {
    expect(boardHasReadingOrder(items)).toBe(true);
    expect(boardHasReadingOrder([connector('c', 'a', 'b')])).toBe(false);
    expect(readingOrder([])).toEqual([]);
  });

  it('readingOrderText numbers the titles in reading sequence; empty → _empty_', () => {
    const txt = readingOrderText([card('a', 0, 0, 'Alpha'), card('b', 100, 0, 'Beta')]);
    expect(txt).toBe('## Reading order\n\n1. Alpha\n2. Beta');
    expect(readingOrderText([])).toBe('## Reading order\n\n_empty_');
  });
});
