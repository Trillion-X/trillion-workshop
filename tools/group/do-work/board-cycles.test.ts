// packages/group/do-work/board-cycles.test.ts
import { describe, it, expect } from 'vitest';
import { connectorCycles, hasCycle, cycleCount } from './board-cycles';
import type { BoardItem } from '../read-data/group-board-model';

const card = (memberId: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 40, h: 30, isSection: false, childCount: 0, text: memberId, extra: {} } as BoardItem);
// A directed connector from -> to.
const link = (memberId: string, from: string, to: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 4, h: 4, isSection: false, childCount: 0, extra: { fromMemberId: from, toMemberId: to } } as BoardItem);

describe('connectorCycles', () => {
  it('finds a simple directed ring A -> B -> C -> A', () => {
    const board = [card('a'), card('b'), card('c'), link('l1', 'a', 'b'), link('l2', 'b', 'c'), link('l3', 'c', 'a')];
    const cycles = connectorCycles(board);
    expect(cycles.length).toBe(1);
    expect(cycles[0].memberIds).toEqual(['a', 'b', 'c']);
    expect(cycles[0].size).toBe(3);
    expect(cycles[0].isSelfLoop).toBe(false);
  });

  it('is NOT a cycle when the connectors only point one way (a chain / DAG)', () => {
    const board = [card('a'), card('b'), card('c'), link('l1', 'a', 'b'), link('l2', 'b', 'c')];
    expect(connectorCycles(board)).toEqual([]);
  });

  it('two cards pointing at each other (A -> B, B -> A) form a 2-card tangle', () => {
    const board = [card('a'), card('b'), link('l1', 'a', 'b'), link('l2', 'b', 'a')];
    const cycles = connectorCycles(board);
    expect(cycles.length).toBe(1);
    expect(cycles[0].memberIds).toEqual(['a', 'b']);
    expect(cycles[0].isSelfLoop).toBe(false);
  });

  it('flags a self-loop (A -> A) as a 1-card tangle', () => {
    const board = [card('a'), card('b'), link('self', 'a', 'a'), link('l', 'a', 'b')];
    const cycles = connectorCycles(board);
    expect(cycles.length).toBe(1);
    expect(cycles[0].memberIds).toEqual(['a']);
    expect(cycles[0].size).toBe(1);
    expect(cycles[0].isSelfLoop).toBe(true);
  });

  it('reports two independent cycles separately, largest first', () => {
    const board = [
      // ring of 3
      card('a'), card('b'), card('c'), link('l1', 'a', 'b'), link('l2', 'b', 'c'), link('l3', 'c', 'a'),
      // ring of 2
      card('x'), card('y'), link('l4', 'x', 'y'), link('l5', 'y', 'x'),
    ];
    const cycles = connectorCycles(board);
    expect(cycles.map((c) => c.size)).toEqual([3, 2]);
    expect(cycles[0].memberIds).toEqual(['a', 'b', 'c']);
    expect(cycles[1].memberIds).toEqual(['x', 'y']);
  });

  it('merges overlapping cycles that share a card into ONE tangle (the SCC)', () => {
    // a->b->a and b->c->b share b; all three are mutually reachable => one tangle {a,b,c}
    const board = [
      card('a'), card('b'), card('c'),
      link('l1', 'a', 'b'), link('l2', 'b', 'a'), link('l3', 'b', 'c'), link('l4', 'c', 'b'),
    ];
    const cycles = connectorCycles(board);
    expect(cycles.length).toBe(1);
    expect(cycles[0].memberIds).toEqual(['a', 'b', 'c']);
  });

  it('a cycle inside one island leaves the acyclic island alone', () => {
    const board = [
      // island 1: a cycle
      card('a'), card('b'), link('l1', 'a', 'b'), link('l2', 'b', 'a'),
      // island 2: a clean chain (no cycle)
      card('p'), card('q'), card('r'), link('l3', 'p', 'q'), link('l4', 'q', 'r'),
    ];
    const cycles = connectorCycles(board);
    expect(cycles.length).toBe(1);
    expect(cycles[0].memberIds).toEqual(['a', 'b']);
  });

  it('ignores dangling connectors (an endpoint with no card)', () => {
    // b -> ghost is dropped by buildRelationGraph, so a->b->a still a tangle, the dangling edge does nothing
    const board = [card('a'), card('b'), link('l1', 'a', 'b'), link('l2', 'b', 'a'), link('dangle', 'b', 'ghost')];
    const cycles = connectorCycles(board);
    expect(cycles.length).toBe(1);
    expect(cycles[0].memberIds).toEqual(['a', 'b']);
  });

  it('is deterministic regardless of item order', () => {
    const parts = [card('a'), card('b'), card('c'), link('l1', 'a', 'b'), link('l2', 'b', 'c'), link('l3', 'c', 'a')];
    const forward = connectorCycles(parts);
    const reversed = connectorCycles([...parts].reverse());
    expect(reversed).toEqual(forward);
  });

  it('hasCycle / cycleCount agree with connectorCycles', () => {
    const clean = [card('a'), card('b'), link('l', 'a', 'b')];
    const looped = [card('a'), card('b'), link('l1', 'a', 'b'), link('l2', 'b', 'a')];
    expect(hasCycle(clean)).toBe(false);
    expect(cycleCount(clean)).toBe(0);
    expect(hasCycle(looped)).toBe(true);
    expect(cycleCount(looped)).toBe(1);
  });
});
