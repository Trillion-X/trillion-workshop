// packages/group/do-work/board-components.test.ts
import { describe, it, expect } from 'vitest';
import { connectorComponents, componentCount } from './board-components';
import type { BoardItem } from '../read-data/group-board-model';

const card = (memberId: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 40, h: 30, isSection: false, childCount: 0, extra: {} } as BoardItem);
const link = (memberId: string, from: string, to: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 4, h: 4, isSection: false, childCount: 0, extra: { fromMemberId: from, toMemberId: to } } as BoardItem);

// Two islands: {a-b-c chain} and {x-y pair}, plus an isolated card z.
const board: BoardItem[] = [
  card('a'), card('b'), card('c'), card('x'), card('y'), card('z'),
  link('l1', 'a', 'b'), link('l2', 'b', 'c'),
  link('l3', 'x', 'y'),
];

describe('connectorComponents', () => {
  it('partitions connected cards into islands, largest first', () => {
    const comps = connectorComponents(board);
    expect(comps).toHaveLength(2);
    expect(comps[0].memberIds).toEqual(['a', 'b', 'c']);
    expect(comps[0].size).toBe(3);
    expect(comps[0].edgeCount).toBe(2);
    expect(comps[1].memberIds).toEqual(['x', 'y']);
    expect(comps[1].edgeCount).toBe(1);
  });
  it('excludes isolated cards (no connector)', () => {
    const all = connectorComponents(board).flatMap((c) => c.memberIds);
    expect(all).not.toContain('z');
  });
  it('merges a bridge edge into one island', () => {
    const bridged = [...board, link('l4', 'c', 'x')]; // now a-b-c-x-y is one island
    const comps = connectorComponents(bridged);
    expect(comps).toHaveLength(1);
    expect(comps[0].memberIds).toEqual(['a', 'b', 'c', 'x', 'y']);
    expect(comps[0].size).toBe(5);
  });
  it('a fully-connected board is one component', () => {
    const comps = connectorComponents([card('a'), card('b'), card('c'), link('l1', 'a', 'b'), link('l2', 'b', 'c')]);
    expect(comps).toHaveLength(1);
    expect(comps[0].size).toBe(3);
  });
  it('no connectors → no components', () => {
    expect(connectorComponents([card('a'), card('b')])).toEqual([]);
  });
  it('ignores a dangling connector (endpoint absent)', () => {
    const comps = connectorComponents([card('a'), card('b'), link('l', 'a', 'b'), link('bad', 'a', 'ghost')]);
    expect(comps).toHaveLength(1);
    expect(comps[0].memberIds).toEqual(['a', 'b']);
    expect(comps.flatMap((c) => c.memberIds)).not.toContain('ghost');
  });
  it('handles a cycle without infinite loop', () => {
    const comps = connectorComponents([card('a'), card('b'), card('c'), link('l1', 'a', 'b'), link('l2', 'b', 'c'), link('l3', 'c', 'a')]);
    expect(comps).toHaveLength(1);
    expect(comps[0].size).toBe(3);
    expect(comps[0].edgeCount).toBe(3);
  });
  it('is deterministic', () => {
    expect(connectorComponents(board)).toEqual(connectorComponents(board));
  });
});

describe('componentCount', () => {
  it('counts the islands', () => {
    expect(componentCount(board)).toBe(2);
    expect(componentCount([card('a')])).toBe(0);
  });
});
