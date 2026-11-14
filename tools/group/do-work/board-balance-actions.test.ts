// packages/group/do-work/board-balance-actions.test.ts
import { describe, it, expect } from 'vitest';
import type { BoardItem } from '../read-data/group-board-model';
import type { FacetExtract } from '../read-data/board-facet-census';
import { balanceRows, type BalanceFacet } from './board-balance-actions';

const card = (memberId: string, tags: string[], kind: string): BoardItem =>
  ({ memberId, kind, x: 0, y: 0, w: 100, h: 40, text: '', extra: { tags }, isSection: false } as unknown as BoardItem);

const tagExtract: FacetExtract = (it) => ((it.extra?.tags as string[]) ?? []);
const kindExtract: FacetExtract = (it) => [it.kind];
const monoExtract: FacetExtract = () => ['x']; // every card the same → one bucket, no distribution

// tag: idea x4, chore x1 -> [4,1] ; kind: note x3, media x2 -> [3,2]
const board: BoardItem[] = [
  card('a', ['idea'], 'note'), card('b', ['idea'], 'note'), card('c', ['idea'], 'note'),
  card('d', ['idea'], 'media'), card('e', ['chore'], 'media'),
];
const FACETS: BalanceFacet[] = [
  { key: 'tag', label: 'Tag', extract: tagExtract },
  { key: 'kind', label: 'Type', extract: kindExtract },
];

describe('balanceRows — per-facet evenness for the balance panel', () => {
  it('measures each facet and sorts most-lopsided (lowest evenness) first', () => {
    const rows = balanceRows(board, FACETS);
    expect(rows.map((r) => r.key)).toEqual(['tag', 'kind']); // tag ([4,1]) less even than kind ([3,2])
    const tag = rows.find((r) => r.key === 'tag')!;
    expect(tag.dominant).toBe('idea');
    expect(tag.dominantCount).toBe(4); // 4 cards carry the dominant 'idea' tag
    expect(tag.topShare).toBeCloseTo(0.8, 5); // 4 of 5
    expect(tag.distinct).toBe(2);
    expect(tag.evenness).toBeCloseTo(0.722, 2); // Pielou J for [4,1]
    expect(tag.band).toBe('Mixed'); // 0.4 <= 0.722 < 0.75
    const kind = rows.find((r) => r.key === 'kind')!;
    expect(kind.band).toBe('Even'); // [3,2] -> J ~0.97
    expect(kind.evenness).toBeGreaterThan(0.9);
  });

  it('drops a facet with fewer than 2 distinct values (nothing to balance)', () => {
    const rows = balanceRows(board, [...FACETS, { key: 'mono', label: 'Mono', extract: monoExtract }]);
    expect(rows.some((r) => r.key === 'mono')).toBe(false); // one bucket -> no distribution -> omitted
    expect(rows).toHaveLength(2);
  });

  it('an empty board yields no rows', () => {
    expect(balanceRows([], FACETS)).toEqual([]);
  });
});
