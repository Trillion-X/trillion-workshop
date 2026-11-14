// @vitest-environment jsdom
// packages/group/show/BoardTidinessReadout.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { boardTidiness, tidinessBand, BoardTidinessReadout } from './BoardTidinessReadout';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const item = (memberId: string, x: number, y: number, w = 60, h = 40, extra: Record<string, unknown> = {}): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x, y, w, h, isSection: false, childCount: 0, extra } as BoardItem);

describe('boardTidiness', () => {
  it('excludes connectors from the analysis', () => {
    const items = [
      item('a', 0, 0, 60, 60),
      item('b', 10, 10, 60, 60),
      { ...item('e', 5, 5, 60, 60), extra: { fromMemberId: 'a', toMemberId: 'b' } } as BoardItem,
    ];
    const report = boardTidiness(items);
    // only a & b overlap; the connector isn't counted
    expect(report.issues.some((i) => i.memberIds.includes('e'))).toBe(false);
  });
  it('a tidy board → score 1, no issues', () => {
    const report = boardTidiness([item('a', 0, 0), item('b', 200, 0), item('c', 400, 0)]);
    expect(report.score).toBe(1);
    expect(report.issues).toHaveLength(0);
  });
});

describe('tidinessBand', () => {
  it('green/amber/red bands', () => {
    expect(tidinessBand(0.95).label).toBe('Tidy');
    expect(tidinessBand(0.7).label).toBe('A bit messy');
    expect(tidinessBand(0.3).label).toBe('Messy');
  });
});

describe('BoardTidinessReadout component', () => {
  it('shows 100% + a clear message for a tidy board', () => {
    const { container } = render(<BoardTidinessReadout items={[item('a', 0, 0), item('b', 300, 0)]} />);
    expect(container.querySelector('[data-tidiness-score]')!.textContent).toBe('100%');
    expect(container.textContent).toMatch(/Nothing to tidy/);
  });
  it('shows a lower score + issue rows for a messy board; clicking an issue selects its cards', () => {
    const messy = [item('a', 0, 0, 60, 60), item('b', 12, 12, 60, 60), item('c', 24, 24, 60, 60)];
    const picks: string[][] = [];
    const { container } = render(<BoardTidinessReadout items={messy} onPickIssue={(ids) => picks.push([...ids])} />);
    const score = Number(container.querySelector('[data-tidiness-score]')!.textContent!.replace('%', ''));
    expect(score).toBeLessThan(100);
    const issueRows = container.querySelectorAll('[role="button"]');
    expect(issueRows.length).toBeGreaterThan(0);
    fireEvent.click(issueRows[0]);
    expect(picks[0].length).toBe(2); // an issue concerns a pair of cards
  });
  it('names the cards an issue concerns — never a raw member id (R49)', () => {
    const withText = (id: string, x: number, y: number, text: string): BoardItem =>
      ({ ...item(id, x, y, 60, 60), text } as BoardItem);
    const messy = [withText('m-uuid-a', 0, 0, 'Launch plan'), withText('m-uuid-b', 12, 12, 'Budget')];
    const { container } = render(<BoardTidinessReadout items={messy} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Launch plan');
    expect(text).toContain('Budget');
    // The raw member id must NOT leak into the product UI.
    expect(text).not.toContain('m-uuid-a');
    expect(text).not.toContain('m-uuid-b');
  });
  it('shows a "Tidy up" fix button only when there are overlaps, and it fires onTidyUp', () => {
    const overlapping = [item('a', 0, 0, 60, 60), item('b', 12, 12, 60, 60)];
    let fixed = 0;
    const messy = render(<BoardTidinessReadout items={overlapping} onTidyUp={() => { fixed += 1; }} />);
    const fix = messy.container.querySelector('[data-tidiness-fix]')!;
    expect(fix).toBeTruthy();
    fireEvent.click(fix);
    expect(fixed).toBe(1);
    cleanup();
    // A tidy board (no overlaps) hides the fix button.
    const tidy = render(<BoardTidinessReadout items={[item('a', 0, 0), item('b', 300, 0)]} onTidyUp={() => {}} />);
    expect(tidy.container.querySelector('[data-tidiness-fix]')).toBeNull();
  });
});
