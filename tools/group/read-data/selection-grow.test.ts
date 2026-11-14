// packages/group/read-data/selection-grow.test.ts
//
// Proves selection-grow: growSelection (dilate by hops, multi-seed, undirected, kind-scoped, isolated seeds
// survive, dedup, cycle-safe), relationComponentOf (unbounded = the relation component), selectionFrontier
// (the ripple shell at exactly N hops), and shrinkSelection (erode — keep the interior, drop the boundary).

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import { buildRelationGraph } from './relationship-graph';
import { growSelection, relationComponentOf, selectionFrontier, shrinkSelection } from './selection-grow';

const node = (memberId: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, extra: {} } as unknown as BoardItem);
const conn = (memberId: string, from: string, to: string, relationKind?: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to, ...(relationKind ? { relationKind } : {}) } } as unknown as BoardItem);

// two components + an isolated node:  a—b—c—[blocks]—d    e—f    iso
const items: BoardItem[] = [
  node('a'), node('b'), node('c'), node('d'), node('e'), node('f'), node('iso'),
  conn('ab', 'a', 'b'), conn('bc', 'b', 'c'), conn('cd', 'c', 'd', 'blocks'), conn('ef', 'e', 'f'),
];
const graph = buildRelationGraph(items);

describe('growSelection', () => {
  it('dilates by hops — each ring adds the next distance out (undirected)', () => {
    expect(growSelection(graph, ['a'], 0)).toEqual(['a']);            // identity
    expect(growSelection(graph, ['a'], 1)).toEqual(['a', 'b']);
    expect(growSelection(graph, ['a'], 2)).toEqual(['a', 'b', 'c']);
    expect(growSelection(graph, ['a'], 3)).toEqual(['a', 'b', 'c', 'd']);
    expect(growSelection(graph, ['a'], 9)).toEqual(['a', 'b', 'c', 'd']); // saturates at the component
  });

  it('grows from many seeds at once (seeds first in input order, then BFS discovery); dedups seeds', () => {
    expect(growSelection(graph, ['a', 'e'], 1)).toEqual(['a', 'e', 'b', 'f']);
    expect(growSelection(graph, ['a', 'a', 'b'], 0)).toEqual(['a', 'b']); // deduped, no growth at hop 0
  });

  it('an isolated seed stays selected (growth only ADDS); a kind scopes the walk', () => {
    expect(growSelection(graph, ['iso'], 5)).toEqual(['iso']);
    // c's neighbours: b (relates-to) + d (blocks). Scoped to 'blocks' only d is reached.
    expect(growSelection(graph, ['c'], 1, 'blocks')).toEqual(['c', 'd']);
    expect(growSelection(graph, ['c'], 1).sort()).toEqual(['b', 'c', 'd']); // all kinds
  });
});

describe('relationComponentOf', () => {
  it('is the whole relation-connected component of the seeds (unbounded grow)', () => {
    expect(relationComponentOf(graph, ['b']).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(relationComponentOf(graph, ['e']).sort()).toEqual(['e', 'f']);
    expect(relationComponentOf(graph, ['iso'])).toEqual(['iso']);
  });
});

describe('selectionFrontier', () => {
  it('is the ripple shell at EXACTLY N hops (grow(N) minus grow(N-1))', () => {
    expect(selectionFrontier(graph, ['a'], 0)).toEqual(['a']);
    expect(selectionFrontier(graph, ['a'], 1)).toEqual(['b']);
    expect(selectionFrontier(graph, ['a'], 2)).toEqual(['c']);
    expect(selectionFrontier(graph, ['a'], 3)).toEqual(['d']);
    expect(selectionFrontier(graph, ['a'], 4)).toEqual([]); // nothing new past the component
  });
});

describe('shrinkSelection', () => {
  it('erodes — keeps interior ids, drops the boundary (an id with a neighbour outside the set)', () => {
    // {a,b,c}: a's nbr b in-set → keep; b's nbrs a,c in-set → keep; c's nbr d is OUTSIDE → drop c
    expect(shrinkSelection(graph, ['a', 'b', 'c'])).toEqual(['a', 'b']);
  });
  it('an isolated id is interior (no neighbours); dedups; a fully-closed component survives', () => {
    expect(shrinkSelection(graph, ['iso', 'a', 'b'])).toEqual(['iso', 'a']); // b drops (c outside)
    expect(shrinkSelection(graph, ['e', 'f', 'e'])).toEqual(['e', 'f']);     // closed pair, deduped
  });
});
