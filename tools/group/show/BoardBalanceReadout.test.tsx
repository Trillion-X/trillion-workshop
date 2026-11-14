// @vitest-environment jsdom
// packages/group/show/BoardBalanceReadout.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { BoardBalanceReadout, boardBalance } from './BoardBalanceReadout';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const card = (memberId: string, x: number, y: number, w = 40, h = 40, extra: Record<string, unknown> = {}): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x, y, w, h, isSection: false, childCount: 0, extra } as BoardItem);
const section = (memberId: string, x: number, y: number): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x, y, w: 800, h: 800, isSection: true, childCount: 0, extra: {} } as BoardItem);
const connector = (memberId: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 10, h: 10, isSection: false, childCount: 0, extra: { fromMemberId: 'a', toMemberId: 'b' } } as BoardItem);

const balanced = [card('a', 0, 0), card('b', 200, 0), card('c', 0, 200), card('d', 200, 200)];
const lopsided = [card('a', 0, 0), card('b', 20, 0), card('c', 0, 20), card('d', 20, 20), card('e', 400, 400)];

describe('boardBalance', () => {
  it('excludes connectors and section frames', () => {
    const withNoise = [...balanced, section('sec', -100, -100), connector('e1')];
    // The huge section frame would wreck the score if counted; excluding it keeps the grid balanced.
    expect(boardBalance(withNoise).overall).toBeCloseTo(boardBalance(balanced).overall, 5);
    expect(boardBalance(withNoise).overall).toBeGreaterThan(0.8);
  });
  it('scores a balanced grid higher than a lopsided board', () => {
    expect(boardBalance(balanced).overall).toBeGreaterThan(boardBalance(lopsided).overall);
  });
});

describe('BoardBalanceReadout component', () => {
  it('renders a percentage, the quadrant mini-map, and one gauge per metric', () => {
    const { container } = render(<BoardBalanceReadout items={balanced} />);
    expect(container.querySelector('[data-balance-map]')).toBeTruthy();
    const score = container.querySelector('[data-balance-score]')!.textContent!;
    expect(score).toMatch(/^\d+%$/);
    // a metric row per BALANCE_METRICS entry
    expect(container.querySelectorAll('[data-balance-metric]').length).toBe(3);
    expect(container.querySelector('[data-balance-metric="even"]')).toBeTruthy();
    expect(container.querySelector('[data-balance-metric="centered"]')).toBeTruthy();
  });
  it('a balanced grid reads high; a lopsided board reads lower', () => {
    const good = render(<BoardBalanceReadout items={balanced} />);
    const goodPct = Number(good.container.querySelector('[data-balance-score]')!.textContent!.replace('%', ''));
    cleanup();
    const bad = render(<BoardBalanceReadout items={lopsided} />);
    const badPct = Number(bad.container.querySelector('[data-balance-score]')!.textContent!.replace('%', ''));
    expect(goodPct).toBeGreaterThan(badPct);
    expect(goodPct).toBeGreaterThan(80);
  });
});
