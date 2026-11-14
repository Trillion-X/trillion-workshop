// packages/group/read-data/board-measure-bucket.test.ts
//
// Proves b176's measure-bucketing adapter: bucketFacet (half-open band assignment, no-measure → no band),
// evenBuckets (edge/label math), and that a HISTOGRAM is a configuration of the census — bucketDistribution
// re-projects facetCensus onto band order with zero-fill, showing empty bands the raw census omits.

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import { facetCensus } from './board-facet-census';
import { bucketFacet, evenBuckets, bucketDistribution, bucketDistributionText, type BucketSpec } from './board-measure-bucket';
import type { BoardMeasure } from './board-facet-pivot';

const card = (memberId: string, score: number | null): BoardItem =>
  ({ memberId, kind: 'note', x: 0, y: 0, w: 100, h: 40, text: '', extra: { score }, isSection: false } as unknown as BoardItem);
const scoreOf: BoardMeasure = (i) => {
  const s = (i.extra as { score?: number | null }).score;
  return typeof s === 'number' ? s : null;
};

// three bands: Low [<10), Mid [10..20), High [>=20)
const SPEC: BucketSpec = { edges: [10, 20], labels: ['Low', 'Mid', 'High'] };

describe('bucketFacet', () => {
  it('assigns half-open bands: below first edge, interior, at-edge goes up, at/above last edge', () => {
    const b = bucketFacet(scoreOf, SPEC);
    expect(b(card('a', 5))).toEqual(['Low']);
    expect(b(card('a', 9.99))).toEqual(['Low']);
    expect(b(card('a', 10))).toEqual(['Mid']); // half-open: edge belongs to the upper band
    expect(b(card('a', 15))).toEqual(['Mid']);
    expect(b(card('a', 20))).toEqual(['High']);
    expect(b(card('a', 999))).toEqual(['High']);
  });

  it('a card with no measure (or non-finite) joins NO band', () => {
    const b = bucketFacet(scoreOf, SPEC);
    expect(b(card('a', null))).toEqual([]);
    expect(b(card('a', Infinity))).toEqual([]);
  });
});

describe('evenBuckets', () => {
  it('computes interior edges + N labels over an even split', () => {
    const spec = evenBuckets(0, 100, 4);
    expect(spec.edges).toEqual([25, 50, 75]);
    expect(spec.labels).toEqual(['0–25', '25–50', '50–75', '75–100']);
  });
  it('a custom formatter + count floored at 1', () => {
    expect(evenBuckets(0, 1, 2, (lo, hi) => `${lo}-${hi}`).labels).toEqual(['0-0.5', '0.5-1']);
    expect(evenBuckets(0, 10, 0).labels.length).toBe(1); // floored to 1 band
  });
});

describe('bucketDistribution — a histogram is a configuration of the census', () => {
  const board = [card('a', 3), card('b', 5), card('c', 12), card('d', 30), card('e', 31), card('f', null)];

  it('bands in ORDER with zero-fill, cards with no measure absent', () => {
    // Low: a,b (2); Mid: c (1); High: d,e (2); f unmeasured → in no band
    const bands = bucketDistribution(board, scoreOf, SPEC);
    expect(bands.map((b) => [b.label, b.count])).toEqual([['Low', 2], ['Mid', 1], ['High', 2]]);
    expect(bands[0].cardIds).toEqual(['a', 'b']);
  });

  it('shows an EMPTY band as 0 (the raw census omits it)', () => {
    const board2 = [card('a', 3), card('b', 4)]; // only Low populated
    const bands = bucketDistribution(board2, scoreOf, SPEC);
    expect(bands.map((b) => b.count)).toEqual([2, 0, 0]);
    // the census itself only has the one populated value
    expect(facetCensus(board2, bucketFacet(scoreOf, SPEC)).map((t) => t.value)).toEqual(['Low']);
  });

  it('the counts match the census exactly (composition, not a second reducer)', () => {
    const census = facetCensus(board, bucketFacet(scoreOf, SPEC));
    const dist = bucketDistribution(board, scoreOf, SPEC);
    for (const t of census) expect(dist.find((d) => d.label === t.value)?.count).toBe(t.cardCount);
  });
});

describe('bucketDistributionText', () => {
  it('renders bands in order with a proportional bar scaled to the peak', () => {
    const board = [card('a', 3), card('b', 5), card('c', 12)]; // Low 2, Mid 1, High 0
    const txt = bucketDistributionText(board, scoreOf, SPEC, 'Scores');
    expect(txt).toBe('## Scores\n\n- Low — 2 ████████████\n- Mid — 1 ██████\n- High — 0');
  });
});
