// packages/group/read-data/board-facet-balance.test.ts
//
// Proves b169 — facet balance — on two levels: (1) the `distributionBalance` kernel with exact Pielou-evenness
// math + edge cases (single bucket, empty, non-finite) + the L069 deletion test (balance a raw number list the
// engine was never written for); (2) `facetBalance` emergence over the REAL BOARD_ITEM_FACETS (tag vs colour).

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import {
  distributionBalance,
  facetBalance,
  evennessBandOf,
  facetBalanceText,
  EVENNESS_BANDS,
} from './board-facet-balance';
import { BOARD_ITEM_FACETS, colorFacetOf } from '../show/board-item-facets';
import { seededFillStack } from '../show/item-fill';

function card(memberId: string, extra: Record<string, unknown> = {}): BoardItem {
  return { memberId, kind: 'note', x: 0, y: 0, w: 100, h: 40, extra } as unknown as BoardItem;
}

describe('distributionBalance — the Pielou-evenness kernel', () => {
  it('a perfectly even distribution → evenness 1', () => {
    const b = distributionBalance([5, 5, 5, 5]);
    expect(b.evenness).toBeCloseTo(1, 10);
    expect(b.topShare).toBeCloseTo(0.25, 10);
    expect(b.distinct).toBe(4);
    expect(b.total).toBe(20);
  });

  it('a single bucket → maximally concentrated (evenness 0, topShare 1), no ln(1) division', () => {
    expect(distributionBalance([7])).toEqual({ evenness: 0, topShare: 1, distinct: 1, total: 7 });
  });

  it('a skewed distribution sits between 0 and 1 and below an even one', () => {
    const skewed = distributionBalance([90, 5, 5]);
    const even = distributionBalance([33, 33, 34]);
    expect(skewed.evenness).toBeGreaterThan(0);
    expect(skewed.evenness).toBeLessThan(1);
    expect(skewed.evenness).toBeLessThan(even.evenness);
    expect(skewed.topShare).toBeCloseTo(0.9, 10);
  });

  it('exact two-bucket evenness: [3,1] → H/ln2', () => {
    // p=[0.75,0.25]; H = -(0.75 ln0.75 + 0.25 ln0.25); J = H/ln2
    const p = [0.75, 0.25];
    const h = -(p[0] * Math.log(p[0]) + p[1] * Math.log(p[1]));
    expect(distributionBalance([3, 1]).evenness).toBeCloseTo(h / Math.log(2), 10);
  });

  it('ignores non-positive / non-finite counts; empty → zeroed (no NaN)', () => {
    expect(distributionBalance([5, 0, -2, NaN, 5]).distinct).toBe(2);
    const empty = distributionBalance([]);
    expect(empty).toEqual({ evenness: 0, topShare: 0, distinct: 0, total: 0 });
    expect(distributionBalance([0, 0]).total).toBe(0);
  });

  it('DELETION TEST: a raw number list the engine was never written for balances with zero engine change', () => {
    // Revenue per region, headcount per team — any count distribution. The kernel names none of them.
    expect(distributionBalance([100, 100]).evenness).toBeCloseTo(1, 10);
    expect(distributionBalance([100, 1]).evenness).toBeLessThan(0.5);
  });
});

describe('evennessBandOf + EVENNESS_BANDS', () => {
  it('maps a score to the highest band it clears', () => {
    expect(evennessBandOf(0.9).key).toBe('even');
    expect(evennessBandOf(0.5).key).toBe('mixed');
    expect(evennessBandOf(0.1).key).toBe('dominated');
    expect(evennessBandOf(0).key).toBe('dominated');
    expect(evennessBandOf(NaN).key).toBe('dominated');
  });
  it('bands are ordered highest-threshold first and end at 0', () => {
    expect(EVENNESS_BANDS[EVENNESS_BANDS.length - 1].minEvenness).toBe(0);
  });
});

describe('facetBalance — emergence over the REAL BOARD_ITEM_FACETS (one measure, many facets)', () => {
  it('tag balance: an all-one-tag board is Dominated; an even split is Even', () => {
    const dominated = [card('a', { tags: ['x'] }), card('b', { tags: ['x'] }), card('c', { tags: ['x'] })];
    // one distinct value → evenness 0
    expect(facetBalance(dominated, BOARD_ITEM_FACETS.tag).evenness).toBe(0);
    const even = [card('a', { tags: ['x'] }), card('b', { tags: ['y'] })];
    expect(facetBalance(even, BOARD_ITEM_FACETS.tag).evenness).toBeCloseTo(1, 10);
  });

  it('colour balance: the SAME measure over the colorFamily extractor', () => {
    const items = [
      card('a', { visualLayerStack: seededFillStack('#2563eb') }), // Blue
      card('b', { visualLayerStack: seededFillStack('#1d4ed8') }), // Blue
      card('c', { visualLayerStack: seededFillStack('#dc2626') }), // Red
    ];
    const bal = facetBalance(items, colorFacetOf);
    expect(bal.distinct).toBe(2);
    expect(bal.topShare).toBeCloseTo(2 / 3, 10); // Blue 2 of 3
    expect(bal.evenness).toBeGreaterThan(0);
    expect(bal.evenness).toBeLessThan(1);
  });

  it('facetBalanceText: band + evenness + dominant share, or _empty_', () => {
    const dominated = [card('a', { tags: ['x'] }), card('b', { tags: ['x'] }), card('c', { tags: ['y'] })];
    const txt = facetBalanceText(dominated, BOARD_ITEM_FACETS.tag, 'Tag balance');
    expect(txt).toContain('## Tag balance');
    expect(txt).toContain('top "x" is 67% of 3 across 2 values');
    expect(facetBalanceText([], BOARD_ITEM_FACETS.tag, 'Tag balance')).toBe('## Tag balance\n\n_empty_');
  });
});
