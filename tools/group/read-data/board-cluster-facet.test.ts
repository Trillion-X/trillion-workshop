// packages/group/read-data/board-cluster-facet.test.ts
//
// Proves b178's cluster facet: each card gets its connected-component label, orphans/small components are
// excluded (minSize), labels are configurable, and — the point — the WHOLE reducer family (census, pivot,
// crosstab) reduces per-cluster through it with zero new reducer (L069 emergence / deletion test).

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import { clusterFacet } from './board-cluster-facet';
import { facetCensus, type FacetExtract } from './board-facet-census';
import { facetPivot, aggregatorById, type BoardMeasure } from './board-facet-pivot';
import { crossTab, cell } from './board-crosstab';

const card = (memberId: string, tags: string[] = [], metric?: { current: number; target: number }): BoardItem =>
  ({ memberId, kind: 'note', x: 0, y: 0, w: 100, h: 40, text: '', extra: { tags, ...(metric ? { metric } : {}) }, isSection: false } as unknown as BoardItem);
const conn = (memberId: string, from: string, to: string): BoardItem =>
  ({ memberId, kind: 'note', x: 0, y: 0, w: 4, h: 4, extra: { fromMemberId: from, toMemberId: to }, isSection: false } as unknown as BoardItem);

// cluster {a,b,c} (size 3) — cluster {d,e} (size 2) — orphan f (size 1)
const board: BoardItem[] = [
  card('a', ['x'], { current: 8, target: 10 }), card('b', ['y'], { current: 4, target: 10 }), card('c', ['x']),
  card('d', ['x'], { current: 2, target: 10 }), card('e', ['y'], { current: 6, target: 10 }),
  card('f', ['z']),
  conn('e1', 'a', 'b'), conn('e2', 'b', 'c'), conn('e3', 'd', 'e'),
];
const tagsOf: FacetExtract = (i) => ((i.extra as { tags?: string[] }).tags ?? []);
const progress: BoardMeasure = (i) => { const m = (i.extra as { metric?: { current: number; target: number } }).metric; return m ? m.current / m.target : null; };

describe('clusterFacet', () => {
  it('labels each card by its connected component (largest = Cluster 1), orphan excluded at default minSize', () => {
    const f = clusterFacet(board);
    expect(f(board[0])).toEqual(['Cluster 1']); // a — in {a,b,c}
    expect(f(board[2])).toEqual(['Cluster 1']); // c
    expect(f(board[3])).toEqual(['Cluster 2']); // d — in {d,e}
    expect(f(board[5])).toEqual([]);            // f — orphan, minSize 2 → no cluster
  });

  it('minSize:1 includes the orphan as its own cluster; labelOf overrides the label', () => {
    expect(clusterFacet(board, { minSize: 1 })(board[5])).toEqual(['Cluster 3']); // f now a size-1 cluster, rank 2
    const named = clusterFacet(board, { labelOf: (rank, island) => `${island.size}-card group` });
    expect(named(board[0])).toEqual(['3-card group']);
    expect(named(board[3])).toEqual(['2-card group']);
  });

  it('a connector emits no cluster; an empty board → an extractor that maps nothing', () => {
    const f = clusterFacet(board);
    expect(f(board[6])).toEqual([]); // e1 connector
    expect(clusterFacet([])(card('z'))).toEqual([]);
  });
});

describe('the reducer family reduces per-cluster through clusterFacet (L069 emergence)', () => {
  it('census → cards per cluster', () => {
    const c = facetCensus(board, clusterFacet(board));
    expect(c.map((t) => [t.value, t.cardCount])).toEqual([['Cluster 1', 3], ['Cluster 2', 2]]); // orphan absent
  });

  it('pivot → average progress per cluster', () => {
    // Cluster 1: a=.8, b=.4, c=unmeasured → mean(.8,.4)=.6 ; Cluster 2: d=.2, e=.6 → .4
    const p = facetPivot(board, clusterFacet(board), progress, aggregatorById('mean')!);
    expect(p.find((r) => r.value === 'Cluster 1')).toMatchObject({ result: 0.6000000000000001, measured: 2, cardCount: 3 });
    expect(p.find((r) => r.value === 'Cluster 2')).toMatchObject({ result: 0.4, measured: 2, cardCount: 2 });
  });

  it('crosstab → cluster × tag, zero new reducer (the deletion test)', () => {
    const t = crossTab(board, clusterFacet(board), tagsOf);
    expect(cell(t, 'Cluster 1', 'x')?.count).toBe(2); // a, c
    expect(cell(t, 'Cluster 1', 'y')?.count).toBe(1); // b
    expect(cell(t, 'Cluster 2', 'x')?.count).toBe(1); // d
    expect(t.rowTotals.get('Cluster 1')).toBe(3);
  });
});
