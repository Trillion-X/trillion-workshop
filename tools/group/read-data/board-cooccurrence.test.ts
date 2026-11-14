// packages/group/read-data/board-cooccurrence.test.ts
//
// Proves b168 — co-occurrence / affinity — on two levels: (1) exact math with a hand-injected extractor
// (readable, catalog-independent, incl. the space-in-value collision case the NUL key defends); (2) emergence
// over the REAL BOARD_ITEM_FACETS (the deletion test made a test — the same reducer over a different extractor).
// Also proves b170 — scoredCooccurrence — reusing the b117 COOCCURRENCE_MEASURES catalog (Jaccard/lift/count)
// over the generic id-carrying engine (exact lift/Jaccard math + card ids carried + genericity).

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import {
  cooccurrence,
  topPair,
  valuesRelatedTo,
  cardIdsForPair,
  cardIdsForTopPair,
  boardHasCooccurrence,
  cooccurrenceText,
  scoredCooccurrence,
  scoredCooccurrenceText,
} from './board-cooccurrence';
import { BOARD_ITEM_FACETS } from '../show/board-item-facets';

function card(memberId: string, tags: string[] = []): BoardItem {
  return { memberId, kind: 'note', x: 0, y: 0, w: 100, h: 40, extra: { tags } } as unknown as BoardItem;
}
function connector(memberId: string): BoardItem {
  return { memberId, kind: 'note', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'a', toMemberId: 'b' } } as unknown as BoardItem;
}
function region(memberId: string): BoardItem {
  return { memberId, kind: 'note', x: 0, y: 0, w: 100, h: 40, extra: { regionHeading: true } } as unknown as BoardItem;
}

describe('cooccurrence — exact math over an injected extractor', () => {
  const extract = (i: BoardItem) => (i.extra?.tags as string[] | undefined) ?? [];
  const items = [
    card('a', ['design', 'urgent']),
    card('b', ['design', 'urgent']),
    card('c', ['design', 'later']),
    card('d', ['solo']),                 // <2 values → no pair
    card('e', ['urgent', 'design']),     // order-independent → same {design,urgent} pair
    card('f', ['dup', 'dup']),           // repeated value → no pair (needs 2 DISTINCT)
    connector('x'),                       // excluded
    region('r'),                          // excluded
  ];

  it('tallies unordered pairs (a<b), shared-count desc then a,b asc', () => {
    expect(cooccurrence(items, extract)).toEqual([
      { a: 'design', b: 'urgent', cardCount: 3, cardIds: ['a', 'b', 'e'] },
      { a: 'design', b: 'later', cardCount: 1, cardIds: ['c'] },
    ]);
  });

  it('a card with <2 distinct values contributes no pair', () => {
    const pairs = cooccurrence([card('d', ['solo']), card('f', ['dup', 'dup'])], extract);
    expect(pairs).toEqual([]);
  });

  it('topPair / cardIdsForPair (order-independent) / cardIdsForTopPair', () => {
    expect(topPair(items, extract)).toEqual({ a: 'design', b: 'urgent', cardCount: 3, cardIds: ['a', 'b', 'e'] });
    expect(cardIdsForPair(items, extract, 'urgent', 'design')).toEqual(['a', 'b', 'e']); // reversed args → same
    expect(cardIdsForTopPair(items, extract)).toEqual(['a', 'b', 'e']);
  });

  it('valuesRelatedTo ranks a value\'s partners', () => {
    expect(valuesRelatedTo(items, extract, 'design')).toEqual([
      { value: 'urgent', cardCount: 3 },
      { value: 'later', cardCount: 1 },
    ]);
    expect(valuesRelatedTo(items, extract, 'urgent')).toEqual([{ value: 'design', cardCount: 3 }]);
  });

  it('boardHasCooccurrence / text', () => {
    expect(boardHasCooccurrence(items, extract)).toBe(true);
    expect(boardHasCooccurrence([card('d', ['solo'])], extract)).toBe(false);
    expect(cooccurrenceText(items, extract, 'Tag affinity')).toBe(
      '## Tag affinity\n\n- design + urgent — 3 cards\n- design + later — 1 card',
    );
    expect(cooccurrenceText([], extract, 'Tag affinity')).toBe('## Tag affinity\n\n_none_');
  });

  it('values containing spaces do NOT collide (NUL-keyed pairs)', () => {
    // {"a b","c"} and {"a","b c"} must be TWO distinct pairs, not merged by a space-joined key.
    const spaced = [card('p', ['a b', 'c']), card('q', ['a', 'b c'])];
    const pairs = cooccurrence(spaced, extract);
    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => [p.a, p.b])).toEqual(expect.arrayContaining([['a b', 'c'], ['a', 'b c']]));
  });
});

describe('cooccurrence — emergence: the SAME reducer over different multi-value extractors', () => {
  it('the REAL BOARD_ITEM_FACETS.tag extractor → tag affinity from the shared reducer', () => {
    const items = [card('a', ['x', 'y']), card('b', ['x', 'y']), card('c', ['x', 'z'])];
    const pairs = cooccurrence(items, BOARD_ITEM_FACETS.tag);
    expect(pairs[0]).toEqual({ a: 'x', b: 'y', cardCount: 2, cardIds: ['a', 'b'] });
    expect(pairs.find((p) => p.a === 'x' && p.b === 'z')?.cardCount).toBe(1);
  });

  it('DELETION TEST: a never-coded dimension (a card\'s "skills") co-occurs with zero engine change', () => {
    // Drop in a completely different multi-value extractor the reducer was never written for. It clusters
    // the co-occurring skills exactly like tags — proof the engine owns no dimension, only the pairing.
    const skillsOf = (i: BoardItem) => (i.extra?.skills as string[] | undefined) ?? [];
    const people = [
      { memberId: 'p1', kind: 'note', x: 0, y: 0, w: 1, h: 1, extra: { skills: ['rust', 'wasm'] } },
      { memberId: 'p2', kind: 'note', x: 0, y: 0, w: 1, h: 1, extra: { skills: ['rust', 'wasm'] } },
      { memberId: 'p3', kind: 'note', x: 0, y: 0, w: 1, h: 1, extra: { skills: ['rust', 'ui'] } },
    ] as unknown as BoardItem[];
    const pairs = cooccurrence(people, skillsOf);
    expect(pairs[0]).toEqual({ a: 'rust', b: 'wasm', cardCount: 2, cardIds: ['p1', 'p2'] });
    expect(pairs.find((p) => p.a === 'rust' && p.b === 'ui')?.cardCount).toBe(1);
  });
});

describe('scoredCooccurrence (b170) — the b117 measure catalog over the generic id-carrying engine', () => {
  const tagsOf = (i: BoardItem) => (i.extra?.tags as string[] | undefined) ?? [];
  // {x,y} always together (both rare, 2 cards) vs {big,*} (big is common: 3 cards, each partner once).
  const items = [
    { memberId: 't1', kind: 'note', x: 0, y: 0, w: 1, h: 1, extra: { tags: ['x', 'y'] } },
    { memberId: 't2', kind: 'note', x: 0, y: 0, w: 1, h: 1, extra: { tags: ['x', 'y'] } },
    { memberId: 't3', kind: 'note', x: 0, y: 0, w: 1, h: 1, extra: { tags: ['big', 'p'] } },
    { memberId: 't4', kind: 'note', x: 0, y: 0, w: 1, h: 1, extra: { tags: ['big', 'q'] } },
    { memberId: 't5', kind: 'note', x: 0, y: 0, w: 1, h: 1, extra: { tags: ['big', 'r'] } },
  ] as unknown as BoardItem[];
  // totals: x=2,y=2,big=3,p=q=r=1; n=5.

  it('default measure is Jaccard ("together"): {x,y} always-together = weight 1.0, carries cardIds', () => {
    const scored = scoredCooccurrence(items, tagsOf);
    expect(scored[0]).toMatchObject({ a: 'x', b: 'y', cardCount: 2, cardIds: ['t1', 't2'] });
    expect(scored[0].weight).toBeCloseTo(1, 10); // 2 / (2+2-2)
    // {big,p}: 1/(3+1-1) = 1/3
    expect(scored.find((s) => s.a === 'big' && s.b === 'p')?.weight).toBeCloseTo(1 / 3, 10);
  });

  it('measure "lift" ranks by attraction-vs-chance: {x,y} lift = (2·5)/(2·2) = 2.5, top', () => {
    const scored = scoredCooccurrence(items, tagsOf, { measure: 'lift' });
    expect(scored[0]).toMatchObject({ a: 'x', b: 'y' });
    expect(scored[0].weight).toBeCloseTo(2.5, 10);
    // {big,p}: (1·5)/(3·1) = 1.667
    expect(scored.find((s) => s.a === 'big' && s.b === 'p')?.weight).toBeCloseTo(5 / 3, 10);
  });

  it('measure "count" = raw shared cards (matches cooccurrence cardCount)', () => {
    const scored = scoredCooccurrence(items, tagsOf, { measure: 'count' });
    expect(scored[0].weight).toBe(2); // {x,y} shares 2 cards
  });

  it('minCount drops thin pairs; limit keeps top-N', () => {
    expect(scoredCooccurrence(items, tagsOf, { measure: 'count', minCount: 2 }).every((s) => s.cardCount >= 2)).toBe(true);
    expect(scoredCooccurrence(items, tagsOf, { limit: 1 })).toHaveLength(1);
  });

  it('scoredCooccurrenceText renders weight + card count, or _none_', () => {
    const txt = scoredCooccurrenceText(items, tagsOf, 'Tag lift', { measure: 'lift', limit: 1 });
    expect(txt).toBe('## Tag lift\n\n- x + y — 2.50 (2 cards)');
    expect(scoredCooccurrenceText([], tagsOf, 'Tag lift')).toBe('## Tag lift\n\n_none_');
  });

  it('generic: the SAME scoring works over the REAL BOARD_ITEM_FACETS.tag extractor', () => {
    const scored = scoredCooccurrence(items, BOARD_ITEM_FACETS.tag, { measure: 'lift' });
    expect(scored[0].a).toBe('x');
    expect(scored[0].b).toBe('y');
  });
});
