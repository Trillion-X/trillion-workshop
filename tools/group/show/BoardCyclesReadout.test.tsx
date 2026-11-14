// @vitest-environment jsdom
// packages/group/show/BoardCyclesReadout.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { BoardCyclesReadout, boardCycles } from './BoardCyclesReadout';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const card = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 40, h: 30, isSection: false, childCount: 0, text, extra: {} } as BoardItem);
const link = (memberId: string, from: string, to: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 4, h: 4, isSection: false, childCount: 0, extra: { fromMemberId: from, toMemberId: to } } as BoardItem);

const ring = [
  card('a', 'Design'), card('b', 'Build'), card('c', 'Ship'),
  link('l1', 'a', 'b'), link('l2', 'b', 'c'), link('l3', 'c', 'a'),
];

describe('boardCycles', () => {
  it('returns the tangle of cards caught in the loop', () => {
    const cycles = boardCycles(ring);
    expect(cycles.length).toBe(1);
    expect(cycles[0].memberIds).toEqual(['a', 'b', 'c']);
  });
});

describe('BoardCyclesReadout component', () => {
  it('warns about each tangle and clicking one selects its cards', () => {
    const picks: string[][] = [];
    const { container } = render(<BoardCyclesReadout items={ring} onPickCycle={(ids) => picks.push([...ids])} />);
    expect(container.querySelector('[data-board-cycles]')).not.toBeNull();
    expect(container.textContent).toMatch(/Circular dependencies/);
    expect(container.querySelectorAll('[data-cycle]').length).toBe(1);
    fireEvent.click(container.querySelector('[data-cycle="a"]')!);
    expect(picks[0]).toEqual(['a', 'b', 'c']);
  });
  it('renders a self-loop preview', () => {
    const selfBoard = [card('a', 'Loops'), card('b', 'Other'), link('s', 'a', 'a'), link('l', 'a', 'b')];
    const { container } = render(<BoardCyclesReadout items={selfBoard} />);
    expect(container.textContent).toMatch(/itself/);
  });
  it('renders nothing on a clean acyclic board', () => {
    const dag = [card('a', 'A'), card('b', 'B'), link('l', 'a', 'b')];
    const { container } = render(<BoardCyclesReadout items={dag} />);
    expect(container.querySelector('[data-board-cycles]')).toBeNull();
  });
});
