// @vitest-environment jsdom
// packages/group/show/BoardBottlenecksReadout.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { BoardBottlenecksReadout, boardBottlenecks } from './BoardBottlenecksReadout';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const card = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 40, h: 30, isSection: false, childCount: 0, text, extra: {} } as BoardItem);
const link = (memberId: string, from: string, to: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 4, h: 4, isSection: false, childCount: 0, extra: { fromMemberId: from, toMemberId: to } } as BoardItem);

// star: removing the hub isolates all three leaves
const star = [
  card('hub', 'Kickoff'), card('x', 'Marketing'), card('y', 'Legal'), card('z', 'Finance'),
  link('l1', 'hub', 'x'), link('l2', 'hub', 'y'), link('l3', 'hub', 'z'),
];

describe('boardBottlenecks', () => {
  it('finds the load-bearing card and how many pieces its removal splits', () => {
    const arts = boardBottlenecks(star);
    expect(arts.length).toBe(1);
    expect(arts[0].memberId).toBe('hub');
    expect(arts[0].splitInto).toBe(3);
  });
});

describe('BoardBottlenecksReadout component', () => {
  it('lists the load-bearing cards; clicking one jumps to it', () => {
    const picks: string[] = [];
    const { container } = render(<BoardBottlenecksReadout items={star} onPickBottleneck={(id) => picks.push(id)} />);
    expect(container.querySelector('[data-board-bottlenecks]')).not.toBeNull();
    expect(container.textContent).toMatch(/Load-bearing cards/);
    expect(container.textContent).toMatch(/splits 3/);
    fireEvent.click(container.querySelector('[data-bottleneck="hub"]')!);
    expect(picks).toEqual(['hub']);
  });
  it('renders nothing when the board has redundant paths (a cycle, no single point of failure)', () => {
    const cycle = [card('a', 'A'), card('b', 'B'), card('c', 'C'), link('l1', 'a', 'b'), link('l2', 'b', 'c'), link('l3', 'c', 'a')];
    const { container } = render(<BoardBottlenecksReadout items={cycle} />);
    expect(container.querySelector('[data-board-bottlenecks]')).toBeNull();
  });
  it('renders nothing when there are no connectors', () => {
    const { container } = render(<BoardBottlenecksReadout items={[card('a', 'A'), card('b', 'B')]} />);
    expect(container.querySelector('[data-board-bottlenecks]')).toBeNull();
  });
});
