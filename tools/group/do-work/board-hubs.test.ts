// packages/group/do-work/board-hubs.test.ts
import { describe, it, expect } from 'vitest';
import { nodeDegrees, rankHubs, centralityById, boardHasConnectors, CENTRALITY_MEASURES } from './board-hubs';
import type { BoardItem } from '../read-data/group-board-model';

const card = (memberId: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 40, h: 30, isSection: false, childCount: 0, extra: {} } as BoardItem);
const link = (memberId: string, from: string, to: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 4, h: 4, isSection: false, childCount: 0, extra: { fromMemberId: from, toMemberId: to } } as BoardItem);

// A hub-and-spoke board: "core" links out to a, b, c; d links INTO core; e is isolated.
const board: BoardItem[] = [
  card('core'), card('a'), card('b'), card('c'), card('d'), card('e'),
  link('l1', 'core', 'a'),
  link('l2', 'core', 'b'),
  link('l3', 'core', 'c'),
  link('l4', 'd', 'core'),
];

describe('nodeDegrees', () => {
  it('counts in/out/total per card, connectors excluded', () => {
    const deg = nodeDegrees(board);
    expect(deg.get('core')).toEqual({ inDegree: 1, outDegree: 3, degree: 4 });
    expect(deg.get('a')).toEqual({ inDegree: 1, outDegree: 0, degree: 1 });
    expect(deg.get('d')).toEqual({ inDegree: 0, outDegree: 1, degree: 1 });
    expect(deg.get('e')).toEqual({ inDegree: 0, outDegree: 0, degree: 0 });
    expect(deg.has('l1')).toBe(false); // connectors are not cards
  });
});

describe('rankHubs', () => {
  it('ranks the most-connected card first, drops unconnected cards', () => {
    const hubs = rankHubs(board);
    expect(hubs[0].memberId).toBe('core');
    expect(hubs[0].degree).toBe(4);
    expect(hubs.some((h) => h.memberId === 'e')).toBe(false); // isolated card is not a hub
  });
  it('influence ranks by out-degree; authority by in-degree', () => {
    const infl = rankHubs(board, { measure: 'influence' });
    expect(infl[0].memberId).toBe('core'); // out-degree 3
    expect(infl[0].score).toBe(3);
    const auth = rankHubs(board, { measure: 'authority' });
    // core has in-degree 1; a/b/c each in-degree 1 — core wins the tie on total degree
    expect(auth[0].memberId).toBe('core');
    expect(auth[0].score).toBe(1);
  });
  it('limit keeps the top-N', () => {
    expect(rankHubs(board, { limit: 1 })).toHaveLength(1);
  });
  it('minScore filters weak nodes', () => {
    expect(rankHubs(board, { minScore: 2 }).every((h) => h.score >= 2)).toBe(true);
    expect(rankHubs(board, { minScore: 2 }).map((h) => h.memberId)).toEqual(['core']);
  });
  it('a board with no connectors has no hubs', () => {
    expect(rankHubs([card('x'), card('y')])).toEqual([]);
  });
  it('is deterministic (stable tie-break)', () => {
    expect(rankHubs(board)).toEqual(rankHubs(board));
  });
  it('ignores a dangling connector (endpoint not present)', () => {
    const withDangling = [card('a'), card('b'), link('l', 'a', 'b'), link('bad', 'a', 'ghost')];
    const hubs = rankHubs(withDangling);
    // only the a→b edge counts; 'ghost' is not a node
    expect(hubs.find((h) => h.memberId === 'a')!.degree).toBe(1);
    expect(hubs.some((h) => h.memberId === 'ghost')).toBe(false);
  });
});

describe('centralityById + boardHasConnectors', () => {
  it('falls back to the first measure for unknown/undefined', () => {
    expect(centralityById(undefined).id).toBe('degree');
    expect(centralityById('nope').id).toBe('degree');
    expect(centralityById('authority').id).toBe('authority');
    expect(CENTRALITY_MEASURES).toHaveLength(3);
  });
  it('boardHasConnectors reflects real (non-dangling) edges', () => {
    expect(boardHasConnectors(board)).toBe(true);
    expect(boardHasConnectors([card('x')])).toBe(false);
    expect(boardHasConnectors([card('a'), link('l', 'a', 'ghost')])).toBe(false); // dangling only
  });
});
