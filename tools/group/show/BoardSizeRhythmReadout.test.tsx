// @vitest-environment jsdom
// packages/group/show/BoardSizeRhythmReadout.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { BoardSizeRhythmReadout, boardRhythm } from './BoardSizeRhythmReadout';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const card = (memberId: string, w: number, h: number): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w, h, isSection: false, childCount: 0, extra: {} } as BoardItem);
const section = (memberId: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 900, h: 900, isSection: true, childCount: 0, extra: {} } as BoardItem);
const connector = (memberId: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 4, h: 4, isSection: false, childCount: 0, extra: { fromMemberId: 'a', toMemberId: 'b' } } as BoardItem);

const uniform = [card('a', 100, 60), card('b', 100, 60), card('c', 100, 60)];
const jumbled = [card('a', 40, 30), card('b', 300, 200), card('c', 80, 400)];

describe('boardRhythm', () => {
  it('excludes connectors and section frames', () => {
    const withNoise = [...uniform, section('s'), connector('e')];
    expect(boardRhythm(withNoise).overall).toBeCloseTo(boardRhythm(uniform).overall, 5);
    expect(boardRhythm(withNoise).overall).toBeCloseTo(1, 5);
  });
  it('scores a uniform board higher than a jumbled one', () => {
    expect(boardRhythm(uniform).overall).toBeGreaterThan(boardRhythm(jumbled).overall);
  });
});

describe('BoardSizeRhythmReadout component', () => {
  it('renders a percentage and one gauge per size measure', () => {
    const { container } = render(<BoardSizeRhythmReadout items={uniform} />);
    expect(container.querySelector('[data-rhythm-score]')!.textContent).toMatch(/^\d+%$/);
    expect(container.querySelectorAll('[data-rhythm-measure]').length).toBe(4);
    expect(container.querySelector('[data-rhythm-measure="area"]')).toBeTruthy();
    expect(container.querySelector('[data-rhythm-measure="aspect"]')).toBeTruthy();
  });
  it('a uniform board reads high; a jumbled board reads lower', () => {
    const good = render(<BoardSizeRhythmReadout items={uniform} />);
    const goodPct = Number(good.container.querySelector('[data-rhythm-score]')!.textContent!.replace('%', ''));
    cleanup();
    const bad = render(<BoardSizeRhythmReadout items={jumbled} />);
    const badPct = Number(bad.container.querySelector('[data-rhythm-score]')!.textContent!.replace('%', ''));
    expect(goodPct).toBeGreaterThan(badPct);
    expect(goodPct).toBeGreaterThan(90);
  });
});
