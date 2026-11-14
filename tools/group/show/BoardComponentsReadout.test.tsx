// @vitest-environment jsdom
// packages/group/show/BoardComponentsReadout.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { BoardComponentsReadout, boardComponents } from './BoardComponentsReadout';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const card = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 40, h: 30, isSection: false, childCount: 0, text, extra: {} } as BoardItem);
const link = (memberId: string, from: string, to: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 4, h: 4, isSection: false, childCount: 0, extra: { fromMemberId: from, toMemberId: to } } as BoardItem);

const twoIslands: BoardItem[] = [
  card('a', 'Alpha'), card('b', 'Beta'), card('c', 'Gamma'), card('x', 'Xi'), card('y', 'Psi'),
  link('l1', 'a', 'b'), link('l2', 'b', 'c'), link('l3', 'x', 'y'),
];

describe('boardComponents', () => {
  it('returns the islands largest-first', () => {
    const comps = boardComponents(twoIslands);
    expect(comps.map((c) => c.size)).toEqual([3, 2]);
  });
});

describe('BoardComponentsReadout component', () => {
  it('lists each island with its size; clicking one selects its cards', () => {
    const picks: string[][] = [];
    const { container } = render(<BoardComponentsReadout items={twoIslands} onPickComponent={(ids) => picks.push([...ids])} />);
    expect(container.querySelectorAll('[data-component]').length).toBe(2);
    expect(container.textContent).toMatch(/2 islands/);
    fireEvent.click(container.querySelector('[data-component="a"]')!);
    expect(picks[0]).toEqual(['a', 'b', 'c']);
  });
  it('renders nothing when the board has fewer than 2 islands', () => {
    const oneIsland = [card('a', 'A'), card('b', 'B'), link('l', 'a', 'b')];
    const { container } = render(<BoardComponentsReadout items={oneIsland} />);
    expect(container.querySelector('[data-board-components]')).toBeNull();
  });
  it('renders nothing when there are no connectors', () => {
    const { container } = render(<BoardComponentsReadout items={[card('a', 'A'), card('b', 'B')]} />);
    expect(container.querySelector('[data-board-components]')).toBeNull();
  });
});
