// packages/group/read-data/board-agenda.test.ts
import { describe, it, expect } from 'vitest';
import { boardAgenda, agendaText } from './board-agenda';
import type { BoardItem } from './group-board-model';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1); // fixed "today"
const card = (memberId: string, text: string, dueDate?: number): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text, extra: dueDate ? { dueDate } : {} } as unknown as BoardItem);
const conn = (memberId: string, from: string, to: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

describe('boardAgenda', () => {
  it('groups dated cards by urgency, dropping empty buckets', () => {
    const items = [
      card('a', 'Overdue goal', NOW - 5 * DAY),
      card('b', 'Due today', NOW),
      card('c', 'Soon', NOW + 2 * DAY),
      card('d', 'Later', NOW + 60 * DAY),
      card('nodate', 'no due date'),
      conn('e', 'a', 'b'),
    ];
    const groups = boardAgenda(items, NOW);
    expect(groups.map((g) => g.urgency)).toEqual(['overdue', 'today', 'soon', 'later']); // 'upcoming' bucket empty → dropped
    expect(groups[0].entries.map((e) => e.title)).toEqual(['Overdue goal']);
    expect(groups[1].entries[0].label).toBe('Today');
  });

  it('sorts entries within a group nearest-due first (id tie-break)', () => {
    const items = [
      card('far', 'Far', NOW + 40 * DAY),
      card('near', 'Near', NOW + 20 * DAY),
    ];
    // both 'later'; near (20d) before far (40d).
    expect(boardAgenda(items, NOW)[0].entries.map((e) => e.title)).toEqual(['Near', 'Far']);
  });

  it('uses the card first line as the title', () => {
    expect(boardAgenda([card('a', 'Buy a house\nby 2027', NOW + 5 * DAY)], NOW)[0].entries[0].title).toBe('Buy a house');
  });

  it('is empty when no card has a due date', () => {
    expect(boardAgenda([card('a', 'x'), card('b', 'y')], NOW)).toEqual([]);
  });
});

describe('agendaText', () => {
  it('renders a header per group + a line per card, with a title', () => {
    const items = [card('a', 'Ship it', NOW - 1 * DAY), card('b', 'Launch', NOW + 30 * DAY)];
    expect(agendaText(boardAgenda(items, NOW), 'Deadlines')).toBe(
      'Deadlines\n\nOverdue (1)\n  Ship it — Yesterday\n\nLater (1)\n  Launch — in 30 days',
    );
  });

  it('says so when the board has no dated goals', () => {
    expect(agendaText(boardAgenda([card('a', 'x')], NOW))).toBe('No dated goals');
  });
});
