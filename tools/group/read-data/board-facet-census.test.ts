// packages/group/read-data/board-facet-census.test.ts
//
// Proves b166 — the generic facet census — on two levels:
//  1. EXACT MATH with a hand-injected extractor (readable, no dependency on the live facet catalog).
//  2. EMERGENCE over the REAL BOARD_ITEM_FACETS (colorFamily / kindFamily / tag) — the deletion test made
//     a test: ONE reducer produces a colour legend AND a type census AND a tag census, zero per-facet code.

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import {
  facetCensus,
  topFacetValue,
  cardIdsForFacetValue,
  cardIdsForTopFacetValue,
  distinctFacetValues,
  boardHasFacet,
  facetCensusText,
} from './board-facet-census';
import { BOARD_ITEM_FACETS, colorFacetOf, kindFamilyOf } from '../show/board-item-facets';
import { seededFillStack } from '../show/item-fill';

function card(memberId: string, extra: Record<string, unknown> = {}, kind = 'note'): BoardItem {
  return { memberId, kind, address: { boardId: 'b', memberId }, position: { x: 0, y: 0 }, extra } as unknown as BoardItem;
}
function connector(memberId: string, from: string, to: string): BoardItem {
  return card(memberId, { fromMemberId: from, toMemberId: to, 'relates-to': true });
}
function region(memberId: string): BoardItem {
  return card(memberId, { regionHeading: true });
}

describe('facetCensus — exact math over an injected extractor', () => {
  // a toy dimension: each card's `bucket` values, so the math is readable and catalog-independent.
  const extract = (i: BoardItem) => (i.extra?.bucket as string[] | undefined) ?? [];
  const items = [
    card('a', { bucket: ['red'] }),
    card('b', { bucket: ['red'] }),
    card('c', { bucket: ['blue'] }),
    card('d', { bucket: ['red', 'blue'] }), // multi-value: counts once for red AND once for blue
    card('e', { bucket: ['red', 'red'] }),  // repeated: counts ONCE for red
    card('f', {}),                           // no value: imposes no facet
    connector('x', 'a', 'b'),                // excluded
    region('r'),                             // excluded
  ];

  it('tallies content cards per value, most-cards-first then value A→Z', () => {
    expect(facetCensus(items, extract)).toEqual([
      { value: 'red', cardCount: 4, cardIds: ['a', 'b', 'd', 'e'] },
      { value: 'blue', cardCount: 2, cardIds: ['c', 'd'] },
    ]);
  });

  it('counts a card ONCE per distinct value it carries', () => {
    const red = facetCensus(items, extract).find((t) => t.value === 'red')!;
    expect(red.cardCount).toBe(4); // e carries [red,red] but counts once
    expect(red.cardIds).toEqual(['a', 'b', 'd', 'e']);
  });

  it('topFacetValue is the dominant value; cardIds helpers resolve it', () => {
    expect(topFacetValue(items, extract)).toBe('red');
    expect(cardIdsForFacetValue(items, extract, 'blue')).toEqual(['c', 'd']);
    expect(cardIdsForTopFacetValue(items, extract)).toEqual(['a', 'b', 'd', 'e']);
  });

  it('distinctFacetValues / boardHasFacet / text', () => {
    expect(distinctFacetValues(items, extract)).toBe(2);
    expect(boardHasFacet(items, extract)).toBe(true);
    expect(facetCensusText(items, extract, 'Buckets')).toBe(
      '## Buckets\n\n- red — 4 cards\n- blue — 2 cards',
    );
  });

  it('ties break value A→Z', () => {
    const tied = [card('a', { bucket: ['zeta'] }), card('b', { bucket: ['alpha'] })];
    expect(facetCensus(tied, extract).map((t) => t.value)).toEqual(['alpha', 'zeta']);
  });

  it('empty board / no values → empty census, null top, _none_ text', () => {
    expect(facetCensus([card('f', {})], extract)).toEqual([]);
    expect(topFacetValue([], extract)).toBeNull();
    expect(cardIdsForTopFacetValue([], extract)).toEqual([]);
    expect(boardHasFacet([], extract)).toBe(false);
    expect(facetCensusText([], extract, 'Buckets')).toBe('## Buckets\n\n_none_');
  });

  it('singular card wording', () => {
    expect(facetCensusText([card('a', { bucket: ['solo'] })], extract, 'B')).toBe('## B\n\n- solo — 1 card');
  });
});

describe('facetCensus — emergence over the REAL BOARD_ITEM_FACETS (one reducer, many legends)', () => {
  const items = [
    card('n1', { visualLayerStack: seededFillStack('#2563eb') }), // Blue note
    card('n2', { visualLayerStack: seededFillStack('#1d4ed8') }), // Blue note
    card('n3', { visualLayerStack: seededFillStack('#dc2626') }), // Red note
    card('img', {}, 'image'),                         // Image type, no fill
    card('t1', { tags: ['urgent', 'design'] }),      // two tags
    card('t2', { tags: ['urgent'] }),                 // one tag
    connector('c', 'n1', 'n2'),
  ];

  it('colorFamily extractor → a colour legend, zero legend-specific code', () => {
    const legend = facetCensus(items, colorFacetOf);
    const blue = legend.find((t) => t.value === 'Blue')!;
    expect(blue.cardCount).toBe(2);
    expect(blue.cardIds).toEqual(expect.arrayContaining(['n1', 'n2']));
    expect(legend.some((t) => t.value === 'Red')).toBe(true);
    expect(topFacetValue(items, colorFacetOf)).toBe('Blue');
  });

  it('kindFamily extractor → a type census from the SAME reducer', () => {
    const census = facetCensus(items, kindFamilyOf);
    expect(census.find((t) => t.value === 'Note')?.cardCount).toBe(5); // n1,n2,n3,t1,t2
    expect(census.find((t) => t.value === 'Image')?.cardCount).toBe(1);
  });

  it('tag extractor → a tag census; multi-tag cards counted per tag', () => {
    const census = facetCensus(items, BOARD_ITEM_FACETS.tag);
    expect(census.find((t) => t.value === 'urgent')?.cardCount).toBe(2); // t1,t2
    expect(census.find((t) => t.value === 'design')?.cardCount).toBe(1); // t1
    expect(topFacetValue(items, BOARD_ITEM_FACETS.tag)).toBe('urgent');
  });

  it('DELETION TEST: a dimension never coded for (deadline) tallies with zero engine change', () => {
    const withDeadlines = [
      card('d1', { dueDate: Date.UTC(2026, 7, 1) }),
      card('d2', {}),
      card('d3', { dueDate: Date.UTC(2026, 8, 1) }),
    ];
    const census = facetCensus(withDeadlines, BOARD_ITEM_FACETS.deadline);
    expect(census.find((t) => t.value === 'Has deadline')?.cardCount).toBe(2);
    expect(census.find((t) => t.value === 'No deadline')?.cardCount).toBe(1);
  });
});
