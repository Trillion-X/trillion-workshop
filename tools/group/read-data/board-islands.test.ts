// packages/group/read-data/board-islands.test.ts
import { describe, it, expect } from 'vitest';
import {
  boardIslands,
  multiCardIslands,
  islandOf,
  largestIsland,
  islandCount,
  boardHasMultipleClusters,
  clustersText,
} from './board-islands';
import type { BoardItem } from './group-board-model';

const card = (memberId: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text: memberId, extra: {} } as unknown as BoardItem);
// A connector carries from/to in extra (read by connectorEndpoints).
const conn = (memberId: string, from: string, to: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

// Two clusters (a-b-c and x-y) plus a loose card (z).
const twoClusters = (): BoardItem[] => [
  card('a'), card('b'), card('c'), card('x'), card('y'), card('z'),
  conn('e1', 'a', 'b'), conn('e2', 'b', 'c'), conn('e3', 'x', 'y'),
];

describe('boardIslands', () => {
  it('partitions cards into connected components, largest first', () => {
    const islands = boardIslands(twoClusters());
    expect(islands.map((i) => i.memberIds)).toEqual([['a', 'b', 'c'], ['x', 'y'], ['z']]);
    expect(islands.map((i) => i.size)).toEqual([3, 2, 1]);
  });

  it('is undirected — a cousin linked only through a sibling joins the island', () => {
    // a -> b <- c : from a, a DIRECTED walk never reaches c, but they are one undirected island.
    const items = [card('a'), card('b'), card('c'), conn('e1', 'a', 'b'), conn('e2', 'c', 'b')];
    expect(boardIslands(items)[0].memberIds).toEqual(['a', 'b', 'c']);
  });

  it('drops a dangling connector (endpoint not on the board) — no phantom island', () => {
    const items = [card('a'), card('b'), conn('e1', 'a', 'ghost')];
    // a and b are each their own island; the ghost edge connects nothing.
    expect(boardIslands(items).map((i) => i.memberIds)).toEqual([['a'], ['b']]);
  });

  it('connectors are edges, never nodes (excluded from components)', () => {
    const ids = boardIslands(twoClusters()).flatMap((i) => i.memberIds);
    expect(ids).not.toContain('e1');
  });
});

describe('multiCardIslands + islandCount + boardHasMultipleClusters', () => {
  it('multiCardIslands keeps only the ≥2 clusters', () => {
    expect(multiCardIslands(twoClusters()).map((i) => i.memberIds)).toEqual([['a', 'b', 'c'], ['x', 'y']]);
    expect(islandCount(twoClusters())).toBe(2);
  });

  it('boardHasMultipleClusters is true only with ≥2 separate clusters', () => {
    expect(boardHasMultipleClusters(twoClusters())).toBe(true);
    // one cluster + loose cards is NOT fragmentation
    expect(boardHasMultipleClusters([card('a'), card('b'), card('c'), conn('e1', 'a', 'b')])).toBe(false);
    expect(boardHasMultipleClusters([card('a'), card('b')])).toBe(false);
  });
});

describe('islandOf + largestIsland', () => {
  it('islandOf returns the whole component containing a card', () => {
    expect(islandOf(twoClusters(), 'x')).toEqual(['x', 'y']);
    expect(islandOf(twoClusters(), 'z')).toEqual(['z']); // unconnected → itself
    expect(islandOf(twoClusters(), 'nope')).toEqual([]); // not on the board
  });

  it('largestIsland returns the biggest cluster', () => {
    expect(largestIsland(twoClusters())).toEqual(['a', 'b', 'c']);
    expect(largestIsland([])).toEqual([]);
  });
});

describe('clustersText', () => {
  it('reports each multi-card cluster + the loose count', () => {
    expect(clustersText(twoClusters(), 'Map')).toBe(
      ['# Map', '', '## Board clusters (2)', '- Cluster 1 — 3 cards', '- Cluster 2 — 2 cards', '- 1 loose card (unconnected)'].join('\n'),
    );
  });

  it('one connected board notes any loose cards', () => {
    const items = [card('a'), card('b'), card('c'), conn('e1', 'a', 'b')]; // a-b cluster + loose c
    expect(clustersText(items)).toBe('One connected board (+ 1 loose card)');
  });

  it('a single clean cluster reads as one connected board', () => {
    expect(clustersText([card('a'), card('b'), conn('e1', 'a', 'b')])).toBe('One connected board');
  });
});
