// packages/group/do-work/board-date-coverage.test.ts
import { describe, it, expect } from 'vitest';
import { datedCardIds, undatedCardIds, boardHasDateGaps, dateSpan, dateCoverageText } from './board-date-coverage';
import type { BoardItem } from '../read-data/group-board-model';

const D = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const card = (memberId: string, dueMs?: number): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text: memberId, extra: dueMs ? { dueDate: dueMs } : {} } as unknown as BoardItem);
const conn = (memberId: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'a', toMemberId: 'b' } } as unknown as BoardItem);
const heading = (memberId: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text: 'Group', extra: { regionHeading: true } } as unknown as BoardItem);

// two dated (Mar 3, Mar 10) + two undated + a connector + a region heading.
const mixed = (): BoardItem[] => [
  card('a', D(2026, 3, 3)), card('b', D(2026, 3, 10)), card('c'), card('d'), conn('e1'), heading('region-heading:x'),
];

describe('datedCardIds / undatedCardIds', () => {
  it('splits content cards by whether they carry a due date', () => {
    expect(datedCardIds(mixed())).toEqual(['a', 'b']);
    expect(undatedCardIds(mixed())).toEqual(['c', 'd']);
  });

  it('excludes connectors AND generated furniture from both', () => {
    const all = [...datedCardIds(mixed()), ...undatedCardIds(mixed())];
    expect(all).not.toContain('e1'); // connector
    expect(all).not.toContain('region-heading:x'); // furniture never "needs a deadline"
  });
});

describe('boardHasDateGaps', () => {
  it('true only when the board is PARTLY scheduled (≥1 dated AND ≥1 undated)', () => {
    expect(boardHasDateGaps(mixed())).toBe(true);
    expect(boardHasDateGaps([card('a', D(2026, 3, 3)), card('b', D(2026, 3, 4))])).toBe(false); // all dated
    expect(boardHasDateGaps([card('a'), card('b')])).toBe(false); // all undated
    expect(boardHasDateGaps([])).toBe(false);
  });
});

describe('dateSpan', () => {
  it('reports earliest/latest/span + counts', () => {
    expect(dateSpan(mixed())).toEqual({
      earliestMs: D(2026, 3, 3), latestMs: D(2026, 3, 10), spanDays: 7, datedCount: 2, undatedCount: 2,
    });
  });

  it('null when no card is dated', () => {
    expect(dateSpan([card('a'), card('b')])).toBeNull();
  });

  it('a single dated card has span 0', () => {
    expect(dateSpan([card('a', D(2026, 3, 3)), card('b')])!.spanDays).toBe(0);
  });
});

describe('dateCoverageText', () => {
  it('renders the window + tallies', () => {
    expect(dateCoverageText(mixed(), 'Plan')).toBe(
      ['# Plan', '', '## Timeline span', '- Window: 2026-03-03 → 2026-03-10 (7 days)', '- Scheduled: 2 cards', '- Undated: 2 cards'].join('\n'),
    );
  });

  it('a single-day span shows one date', () => {
    expect(dateCoverageText([card('a', D(2026, 3, 3))])).toContain('- Window: 2026-03-03');
  });

  it('honest empty when nothing is scheduled', () => {
    expect(dateCoverageText([card('a'), card('b')])).toBe('No scheduled cards');
  });
});
