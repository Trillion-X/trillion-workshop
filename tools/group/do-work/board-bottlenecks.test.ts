// packages/group/do-work/board-bottlenecks.test.ts
import { describe, it, expect } from 'vitest';
import { articulationCards, hasBottleneck, bottleneckCount } from './board-bottlenecks';
import type { BoardItem } from '../read-data/group-board-model';

const card = (memberId: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 40, h: 30, isSection: false, childCount: 0, text: memberId, extra: {} } as BoardItem);
const link = (memberId: string, from: string, to: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 4, h: 4, isSection: false, childCount: 0, extra: { fromMemberId: from, toMemberId: to } } as BoardItem);
const ids = (items: BoardItem[]) => articulationCards(items).map((a) => a.memberId);

describe('articulationCards', () => {
  it('the middle of a chain A - B - C is a bottleneck (removing B splits into 2)', () => {
    const board = [card('a'), card('b'), card('c'), link('l1', 'a', 'b'), link('l2', 'b', 'c')];
    const arts = articulationCards(board);
    expect(arts.length).toBe(1);
    expect(arts[0].memberId).toBe('b');
    expect(arts[0].splitInto).toBe(2);
  });

  it('a card bridging two clusters is load-bearing, and so is its counterpart', () => {
    // cluster {a,b,c} triangle -- bridge d -- cluster {e,f,g} triangle, joined a-d and d-e
    const board = [
      card('a'), card('b'), card('c'), card('d'), card('e'), card('f'), card('g'),
      link('t1', 'a', 'b'), link('t2', 'b', 'c'), link('t3', 'c', 'a'),
      link('t4', 'e', 'f'), link('t5', 'f', 'g'), link('t6', 'g', 'e'),
      link('b1', 'a', 'd'), link('b2', 'd', 'e'),
    ];
    // d is the classic cut vertex; a and e also become cut vertices (they attach their triangle to the bridge)
    expect(ids(board)).toContain('d');
    expect(articulationCards(board).find((x) => x.memberId === 'd')!.splitInto).toBe(2);
  });

  it('a single cycle has NO bottleneck (every card has a redundant path)', () => {
    const board = [card('a'), card('b'), card('c'), link('l1', 'a', 'b'), link('l2', 'b', 'c'), link('l3', 'c', 'a')];
    expect(articulationCards(board)).toEqual([]);
  });

  it('the centre of a star is a bottleneck that splits into as many leaves as it has', () => {
    const board = [
      card('hub'), card('x'), card('y'), card('z'),
      link('l1', 'hub', 'x'), link('l2', 'hub', 'y'), link('l3', 'hub', 'z'),
    ];
    const arts = articulationCards(board);
    expect(arts.length).toBe(1);
    expect(arts[0].memberId).toBe('hub');
    expect(arts[0].splitInto).toBe(3); // remove hub -> x, y, z each isolated
  });

  it('direction does not matter (undirected connectivity)', () => {
    const forward = [card('a'), card('b'), card('c'), link('l1', 'a', 'b'), link('l2', 'b', 'c')];
    const backward = [card('a'), card('b'), card('c'), link('l1', 'b', 'a'), link('l2', 'c', 'b')];
    expect(ids(forward)).toEqual(ids(backward));
  });

  it('ignores dangling connectors and self-loops', () => {
    const board = [card('a'), card('b'), card('c'), link('l1', 'a', 'b'), link('l2', 'b', 'c'), link('self', 'b', 'b'), link('dangle', 'c', 'ghost')];
    expect(ids(board)).toEqual(['b']);
  });

  it('is deterministic regardless of item order', () => {
    const parts = [card('a'), card('b'), card('c'), card('d'), link('l1', 'a', 'b'), link('l2', 'b', 'c'), link('l3', 'c', 'd')];
    expect(articulationCards([...parts].reverse())).toEqual(articulationCards(parts));
  });

  it('hasBottleneck / bottleneckCount agree', () => {
    const chain = [card('a'), card('b'), card('c'), link('l1', 'a', 'b'), link('l2', 'b', 'c')];
    const cycle = [card('a'), card('b'), card('c'), link('l1', 'a', 'b'), link('l2', 'b', 'c'), link('l3', 'c', 'a')];
    expect(hasBottleneck(chain)).toBe(true);
    expect(bottleneckCount(chain)).toBe(1);
    expect(hasBottleneck(cycle)).toBe(false);
    expect(bottleneckCount(cycle)).toBe(0);
  });
});
