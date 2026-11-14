// @vitest-environment jsdom
// packages/group/show/BoardOrderReadout.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { BoardOrderReadout, boardOrder } from './BoardOrderReadout';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const card = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 40, h: 30, isSection: false, childCount: 0, text, extra: {} } as BoardItem);
const link = (memberId: string, from: string, to: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 4, h: 4, isSection: false, childCount: 0, extra: { fromMemberId: from, toMemberId: to } } as BoardItem);

// a -> {b,c} -> d : three waves, the middle one parallel
const diamond = [
  card('a', 'Spec'), card('b', 'Build'), card('c', 'Test'), card('d', 'Ship'),
  link('l1', 'a', 'b'), link('l2', 'a', 'c'), link('l3', 'b', 'd'), link('l4', 'c', 'd'),
];

describe('boardOrder', () => {
  it('lays the board into dependency waves', () => {
    const order = boardOrder(diamond);
    expect(order.waves.map((w) => [...w.memberIds])).toEqual([['a'], ['b', 'c'], ['d']]);
  });
});

describe('BoardOrderReadout component', () => {
  it('lists each wave; clicking one selects its (parallel) cards', () => {
    const picks: string[][] = [];
    const { container } = render(<BoardOrderReadout items={diamond} onPickWave={(ids) => picks.push([...ids])} />);
    expect(container.querySelectorAll('[data-wave]').length).toBe(3);
    expect(container.textContent).toMatch(/Do-order/);
    fireEvent.click(container.querySelector('[data-wave="1"]')!); // the parallel middle wave
    expect(picks[0]).toEqual(['b', 'c']);
  });
  it('warns when some cards are blocked by a cycle', () => {
    const withCycle = [
      card('p', 'P'), card('q', 'Q'), link('l1', 'p', 'q'),
      card('x', 'X'), card('y', 'Y'), link('l2', 'x', 'y'), link('l3', 'y', 'x'),
    ];
    const { container } = render(<BoardOrderReadout items={withCycle} />);
    expect(container.textContent).toMatch(/blocked by a cycle/);
  });
  it('renders nothing when the board has no connectors', () => {
    const { container } = render(<BoardOrderReadout items={[card('a', 'A'), card('b', 'B')]} />);
    expect(container.querySelector('[data-board-order]')).toBeNull();
  });
});
