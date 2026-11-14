// @vitest-environment jsdom
// packages/group/show/BoardHubsReadout.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { BoardHubsReadout, boardHubs } from './BoardHubsReadout';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const card = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 40, h: 30, isSection: false, childCount: 0, text, extra: {} } as BoardItem);
const link = (memberId: string, from: string, to: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 4, h: 4, isSection: false, childCount: 0, extra: { fromMemberId: from, toMemberId: to } } as BoardItem);

const board: BoardItem[] = [
  card('core', 'Core idea'), card('a', 'Branch A'), card('b', 'Branch B'), card('c', 'Branch C'), card('lonely', 'Orphan'),
  link('l1', 'core', 'a'), link('l2', 'core', 'b'), link('l3', 'core', 'c'),
];

describe('boardHubs', () => {
  it('ranks the most-connected card first and excludes the orphan', () => {
    const hubs = boardHubs(board);
    expect(hubs[0].memberId).toBe('core');
    expect(hubs.some((h) => h.memberId === 'lonely')).toBe(false);
  });
});

describe('BoardHubsReadout component', () => {
  it('renders hub rows by label with a connection count; clicking one jumps to it', () => {
    const picks: string[] = [];
    const { container } = render(<BoardHubsReadout items={board} onPickHub={(id) => picks.push(id)} />);
    const rows = container.querySelectorAll('[data-hub]');
    expect(rows.length).toBeGreaterThan(0);
    const coreRow = container.querySelector('[data-hub="core"]')!;
    expect(coreRow.textContent).toMatch(/Core idea/);
    expect(coreRow.textContent).toMatch(/3/); // degree 3
    fireEvent.click(coreRow);
    expect(picks).toEqual(['core']);
  });
  it('shows a friendly empty state when nothing is connected', () => {
    const { container } = render(<BoardHubsReadout items={[card('x', 'x'), card('y', 'y')]} />);
    expect(container.querySelector('[data-hub]')).toBeNull();
    expect(container.textContent).toMatch(/link cards with connectors/i);
  });
  it('honours the centrality measure (authority = in-degree)', () => {
    // b points into a and c → highest in-degree (authority)
    const b2 = [card('a', 'A'), card('b', 'B'), card('c', 'C'), link('l1', 'a', 'b'), link('l2', 'c', 'b')];
    const { container } = render(<BoardHubsReadout items={b2} measure="authority" onPickHub={() => {}} />);
    const first = container.querySelector('[data-hub]')!;
    expect(first.getAttribute('data-hub')).toBe('b');
    expect(container.textContent).toMatch(/pointed to most/i);
  });
});
