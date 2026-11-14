// packages/group/do-work/board-order.test.ts
import { describe, it, expect } from 'vitest';
import { executionOrder, waveCount, parallelWidth, hasBlockedByCycle } from './board-order';
import type { BoardItem } from '../read-data/group-board-model';

const card = (memberId: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 40, h: 30, isSection: false, childCount: 0, text: memberId, extra: {} } as BoardItem);
// A -> B means "A comes before B" (A is a prerequisite of B).
const link = (memberId: string, from: string, to: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 4, h: 4, isSection: false, childCount: 0, extra: { fromMemberId: from, toMemberId: to } } as BoardItem);
const waves = (items: BoardItem[]) => executionOrder(items).waves.map((w) => [...w.memberIds]);

describe('executionOrder', () => {
  it('lays a simple chain A -> B -> C into three sequential waves', () => {
    const board = [card('a'), card('b'), card('c'), link('l1', 'a', 'b'), link('l2', 'b', 'c')];
    expect(waves(board)).toEqual([['a'], ['b'], ['c']]);
    expect(executionOrder(board).blocked).toEqual([]);
  });

  it('puts independent cards in the SAME wave (parallel work)', () => {
    // a -> c, b -> c: a and b have no prerequisites -> wave 0 together; c waits on both -> wave 1
    const board = [card('a'), card('b'), card('c'), link('l1', 'a', 'c'), link('l2', 'b', 'c')];
    expect(waves(board)).toEqual([['a', 'b'], ['c']]);
  });

  it('handles a diamond a -> {b,c} -> d', () => {
    const board = [
      card('a'), card('b'), card('c'), card('d'),
      link('l1', 'a', 'b'), link('l2', 'a', 'c'), link('l3', 'b', 'd'), link('l4', 'c', 'd'),
    ];
    expect(waves(board)).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('excludes cards caught in a cycle (they never come free) and reports them blocked', () => {
    // clean chain p -> q, plus a ring x -> y -> x
    const board = [
      card('p'), card('q'), link('l1', 'p', 'q'),
      card('x'), card('y'), link('l2', 'x', 'y'), link('l3', 'y', 'x'),
    ];
    const order = executionOrder(board);
    expect(order.waves.map((w) => [...w.memberIds])).toEqual([['p'], ['q']]);
    expect(order.blocked).toEqual(['x', 'y']);
  });

  it('a self-loop blocks itself AND everything downstream of it', () => {
    // a -> a (self-loop) so a never frees; b's only prerequisite is a, so b never frees either.
    const board = [card('a'), card('b'), link('self', 'a', 'a'), link('l', 'a', 'b')];
    const order = executionOrder(board);
    expect(order.blocked).toEqual(['a', 'b']);
    expect(order.waves).toEqual([]);
  });

  it('de-dupes a double connector so the target does not wait twice', () => {
    const board = [card('a'), card('b'), link('l1', 'a', 'b'), link('l2', 'a', 'b')];
    expect(waves(board)).toEqual([['a'], ['b']]);
  });

  it('excludes isolated cards (no connector) from the plan', () => {
    const board = [card('a'), card('b'), card('loner'), link('l', 'a', 'b')];
    const order = executionOrder(board);
    expect(order.waves.flatMap((w) => [...w.memberIds])).toEqual(['a', 'b']);
    expect(order.blocked).toEqual([]);
  });

  it('is deterministic regardless of item order', () => {
    const parts = [card('a'), card('b'), card('c'), link('l1', 'a', 'c'), link('l2', 'b', 'c')];
    expect(executionOrder([...parts].reverse())).toEqual(executionOrder(parts));
  });

  it('waveCount = longest chain length, parallelWidth = widest wave', () => {
    const board = [
      card('a'), card('b'), card('c'), card('d'),
      link('l1', 'a', 'b'), link('l2', 'a', 'c'), link('l3', 'b', 'd'), link('l4', 'c', 'd'),
    ];
    expect(waveCount(board)).toBe(3); // a | b,c | d
    expect(parallelWidth(board)).toBe(2); // the b,c wave
  });

  it('hasBlockedByCycle agrees', () => {
    const clean = [card('a'), card('b'), link('l', 'a', 'b')];
    const looped = [card('a'), card('b'), link('l1', 'a', 'b'), link('l2', 'b', 'a')];
    expect(hasBlockedByCycle(clean)).toBe(false);
    expect(hasBlockedByCycle(looped)).toBe(true);
  });
});
