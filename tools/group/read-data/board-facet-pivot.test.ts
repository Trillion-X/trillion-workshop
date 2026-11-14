// packages/group/read-data/board-facet-pivot.test.ts
//
// Proves b175's facet-pivot primitive: the group-by-aggregate over injected (dimension × measure ×
// aggregator), the aggregator DATA registry, the "unmeasured group → null, never fake 0" honesty, the sort,
// and that it GENERALISES the census (measure≡1 + sum ≡ card count) + the L069 deletion test.

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import { facetPivot, facetPivotText, AGGREGATORS, aggregatorById, type BoardMeasure } from './board-facet-pivot';
import { facetCensus, type FacetExtract } from './board-facet-census';

// a card whose tags + a numeric `score` are read by the extractor/measure below
function card(memberId: string, tags: string[], score: number | null): BoardItem {
  return { memberId, kind: 'note', x: 0, y: 0, w: 100, h: 40, text: '', extra: { tags, score }, isSection: false } as unknown as BoardItem;
}
const connector = (memberId: string): BoardItem =>
  ({ memberId, kind: 'note', x: 0, y: 0, w: 4, h: 4, extra: { fromMemberId: 'a', toMemberId: 'b' }, isSection: false } as unknown as BoardItem);

const tagsOf: FacetExtract = (i) => ((i.extra as { tags?: string[] })?.tags ?? []);
const scoreOf: BoardMeasure = (i) => {
  const s = (i.extra as { score?: number | null })?.score;
  return typeof s === 'number' ? s : null;
};
const mean = aggregatorById('mean')!;
const sum = aggregatorById('sum')!;
const max = aggregatorById('max')!;

const board: BoardItem[] = [
  card('a', ['design', 'urgent'], 4),
  card('b', ['design'], 10),
  card('c', ['urgent'], 2),
  card('d', ['design'], null), // in design, but carries no measure
  connector('e1'),
];

describe('AGGREGATORS registry', () => {
  it('has the five built-ins, each a DATA row with a reduce', () => {
    expect(AGGREGATORS.map((a) => a.id)).toEqual(['sum', 'mean', 'max', 'min', 'count']);
    expect(aggregatorById('mean')?.reduce([2, 4])).toBe(3);
    expect(aggregatorById('max')?.reduce([2, 10, 4])).toBe(10);
    expect(aggregatorById('min')?.reduce([2, 10, 4])).toBe(2);
    expect(aggregatorById('sum')?.reduce([1, 2, 3])).toBe(6);
    expect(aggregatorById('count')?.reduce([9, 9])).toBe(2);
    expect(aggregatorById('nope')).toBeNull();
  });
});

describe('facetPivot', () => {
  it('aggregates the measure per group; a card in N tags joins N groups', () => {
    // design: a=4, b=10, d=null → mean of [4,10] = 7 over 3 cards, 2 measured
    // urgent: a=4, c=2 → mean 3 over 2 cards, 2 measured
    const rows = facetPivot(board, tagsOf, scoreOf, mean);
    expect(rows.map((r) => r.value)).toEqual(['design', 'urgent']); // 7 > 3, result-desc
    const design = rows.find((r) => r.value === 'design')!;
    expect(design).toMatchObject({ cardCount: 3, measured: 2, result: 7 });
    expect(rows.find((r) => r.value === 'urgent')).toMatchObject({ cardCount: 2, measured: 2, result: 3 });
    expect(design.cardIds).toEqual(['a', 'b', 'd']);
  });

  it('a group whose cards carry NO measure reports null, never a fake 0, and sorts last', () => {
    const rows = facetPivot(
      [card('a', ['x'], 5), card('b', ['y'], null)],
      tagsOf, scoreOf, mean,
    );
    expect(rows[0]).toMatchObject({ value: 'x', result: 5 });
    expect(rows[1]).toMatchObject({ value: 'y', measured: 0, result: null });
  });

  it('excludes connectors; different aggregators give different results over the same group', () => {
    expect(facetPivot(board, tagsOf, scoreOf, max).find((r) => r.value === 'design')?.result).toBe(10);
    expect(facetPivot(board, tagsOf, scoreOf, sum).find((r) => r.value === 'design')?.result).toBe(14);
  });

  it('GENERALISES the census: measure≡1 + sum ≡ the card count per value', () => {
    const one: BoardMeasure = () => 1;
    const pivot = facetPivot(board, tagsOf, one, sum);
    const census = facetCensus(board, tagsOf);
    for (const c of census) {
      expect(pivot.find((p) => p.value === c.value)?.result).toBe(c.cardCount);
    }
  });

  it('empty board → []', () => {
    expect(facetPivot([], tagsOf, scoreOf, mean)).toEqual([]);
  });

  // L069 DELETION TEST: a never-designed dimension×measure works with zero engine change.
  it('pivots a completely different (dimension × measure × aggregator) with zero engine change', () => {
    const firstLetter: FacetExtract = (i) => [String((i.extra as { tags?: string[] }).tags?.[0] ?? '?')[0]];
    const rows = facetPivot(board, firstLetter, scoreOf, max);
    // 'd' bucket (design cards a,b,d) max score = 10; 'u' bucket (urgent c) = 2
    expect(rows[0]).toMatchObject({ value: 'd', result: 10 });
    expect(rows[1]).toMatchObject({ value: 'u', result: 2 });
  });
});

describe('facetPivotText', () => {
  it('renders each group with the injected value formatter + honest sample size', () => {
    const txt = facetPivotText(board, tagsOf, scoreOf, mean, 'Score by tag', (n) => `${n} pts`);
    expect(txt).toBe('## Score by tag\n\n- design — 7 pts (2/3 cards)\n- urgent — 3 pts (2/2 cards)');
  });

  it('an unmeasured group shows — and the default formatter trims', () => {
    const txt = facetPivotText([card('a', ['x'], null)], tagsOf, scoreOf, mean, 'Empty');
    expect(txt).toBe('## Empty\n\n- x — — (0/1 card)');
    expect(facetPivotText([], tagsOf, scoreOf, mean, 'Nothing')).toBe('## Nothing\n\n_none_');
  });
});
