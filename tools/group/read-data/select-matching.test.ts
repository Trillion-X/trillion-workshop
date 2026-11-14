// packages/group/read-data/select-matching.test.ts
//
// Proves select-matching: the pure core (`selectMatching` over an injected FacetExtract — shared values,
// multi-seed union, value-less seed → []), the DATA-driven dimension form (`selectMatchingByDimension` over the
// real kind/tag facets), the EMERGENT reach (a facet the old selectSame* methods never had — `progress-band` —
// works by a string key), and fail-closed on an unknown dimension.

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import { selectMatching, selectMatchingByDimension } from './select-matching';

// metric is the structured {current,target} shape → completion = current/target (PROGRESS_BUCKETS = 4 even bands)
const item = (memberId: string, kind: string, tags?: string[], progress?: number): BoardItem =>
  ({ kind, memberId, x: 0, y: 0, w: 100, h: 40, extra: { ...(tags ? { tags } : {}), ...(progress !== undefined ? { metric: { current: progress * 10, target: 10 } } : {}) } } as unknown as BoardItem);

//  n1 note  [work,urgent] 0.9 | n2 note [work] 0.9 | n3 image [urgent] 0.1 | n4 note (no tags, no metric)
const items: BoardItem[] = [
  item('n1', 'note', ['work', 'urgent'], 0.9),
  item('n2', 'note', ['work'], 0.9),
  item('n3', 'image', ['urgent'], 0.1),
  item('n4', 'note'),
];
const kindFacet = (i: BoardItem) => [i.kind];

describe('selectMatching (pure core, injected facet)', () => {
  it('selects every card sharing a facet value with the seeds (matching seeds included)', () => {
    // seed n1 by raw kind → all notes (n1,n2,n4); the image n3 differs
    expect(selectMatching(items, ['n1'], kindFacet)).toEqual(['n1', 'n2', 'n4']);
  });
  it('unions the value-sets of many seeds', () => {
    // seeds n1(kind note)+n3(kind image) → both kinds → everything
    expect(selectMatching(items, ['n1', 'n3'], kindFacet)).toEqual(['n1', 'n2', 'n3', 'n4']);
  });
  it('a value-less seed contributes nothing; all-value-less seeds → []', () => {
    const tagFacet = (i: BoardItem) => (Array.isArray((i.extra as { tags?: string[] })?.tags) ? (i.extra as { tags: string[] }).tags : []);
    expect(selectMatching(items, ['n4'], tagFacet)).toEqual([]); // n4 has no tags → nothing to match
  });
});

describe('selectMatchingByDimension (DATA-driven — dissolves the 5 hardcoded selectSame* methods)', () => {
  it('select-same KIND: a note seed grabs the notes, not the image', () => {
    expect(selectMatchingByDimension(items, ['n1'], 'kind')).toEqual(['n1', 'n2', 'n4']);
  });
  it('select-same TAG: unions the seed tags; a tagless card is excluded', () => {
    expect(selectMatchingByDimension(items, ['n1'], 'tag')).toEqual(['n1', 'n2', 'n3']); // work∪urgent
    expect(selectMatchingByDimension(items, ['n2'], 'tag')).toEqual(['n1', 'n2']);        // just work
  });
  it('EMERGENT — a facet the old methods never had (progress-band) is reachable by key', () => {
    // n1,n2 share the high band (0.9); n3 is low (0.1); n4 has no metric → no band → excluded
    expect(selectMatchingByDimension(items, ['n1'], 'progress-band')).toEqual(['n1', 'n2']);
  });
  it('fail-closed: an unknown dimension key → [] (never throws)', () => {
    expect(selectMatchingByDimension(items, ['n1'], 'not-a-dimension')).toEqual([]);
  });
});
