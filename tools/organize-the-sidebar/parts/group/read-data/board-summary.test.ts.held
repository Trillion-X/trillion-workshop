// packages/group/read-data/board-summary.test.ts
import { describe, it, expect } from 'vitest';
import { boardSummary, summaryText, summaryStatRows } from './board-summary';
import type { BoardItem } from './group-board-model';

const card = (memberId: string, text = '', extra: Record<string, unknown> = {}, kind = 'note'): BoardItem =>
  ({ kind, memberId, x: 0, y: 0, w: 100, h: 40, text, extra } as unknown as BoardItem);
const section = (memberId: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, isSection: true, text: '', extra: {} } as unknown as BoardItem);
const conn = (memberId: string, from: string, to: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

describe('boardSummary', () => {
  it('censuses an empty board to all zeros', () => {
    expect(boardSummary([])).toEqual({ cards: 0, connectors: 0, sections: 0, media: 0, words: 0, withDueDate: 0, withProgress: 0, complete: 0, orphans: 0, avgProgress: null });
  });

  it('counts kinds, words, due dates, progress and orphans', () => {
    const items = [
      card('a', 'Buy a house soon', { dueDate: Date.UTC(2027, 0, 1), metric: { current: 50, target: 100 } }),
      card('b', 'Save money', { metric: { current: 100, target: 100 } }),
      conn('e', 'a', 'b'), // connects a & b
      card('img', 'photo', {}, 'media'),
      card('lonely', 'a floating three word note'),
    ];
    const s = boardSummary(items);
    expect(s.cards).toBe(4); // a, b, img, lonely (connector excluded)
    expect(s.connectors).toBe(1);
    expect(s.media).toBe(1);
    expect(s.words).toBe(4 + 2 + 1 + 5); // "Buy a house soon"=4, "Save money"=2, "photo"=1, "a floating three word note"=5
    expect(s.withDueDate).toBe(1);
    expect(s.withProgress).toBe(2);
    expect(s.complete).toBe(1); // b at 100%
    expect(s.avgProgress).toBe(75); // (50 + 100) / 2
    expect(s.orphans).toBe(2); // img + lonely (a & b are connected)
  });

  it('counts sections separately from content cards', () => {
    const s = boardSummary([section('sec'), card('a', 'x')]);
    expect(s.sections).toBe(1);
    expect(s.cards).toBe(1);
  });
});

describe('summaryStatRows', () => {
  it('always shows Cards + Words, omitting the zero-valued optional stats (no filler)', () => {
    // a connected pair → zero orphans/due/progress/media → only Cards, Connectors, Words rows.
    const s = boardSummary([card('a', 'one two'), card('b', 'three four'), conn('e', 'a', 'b')]);
    expect(summaryStatRows(s)).toEqual([
      { key: 'cards', label: 'Cards', value: '2' },
      { key: 'connectors', label: 'Connectors', value: '1' },
      { key: 'words', label: 'Words', value: '4' },
    ]);
  });

  it('includes the optional stats when non-zero, with the goals + avg composite', () => {
    const s = boardSummary([
      card('a', 'goal one', { dueDate: Date.UTC(2027, 0, 1), metric: { current: 100, target: 100 } }),
      card('b', 'floating'),
    ]);
    expect(summaryStatRows(s)).toEqual([
      { key: 'cards', label: 'Cards', value: '2' },
      { key: 'words', label: 'Words', value: '3' },
      { key: 'due', label: 'With a due date', value: '1' },
      { key: 'complete', label: 'Goals complete', value: '1/1 · 100% avg' },
      { key: 'orphans', label: 'Unconnected', value: '2' },
    ]);
  });

  it('an empty board still shows the two always-present stats at zero', () => {
    expect(summaryStatRows(boardSummary([])).map((r) => r.key)).toEqual(['cards', 'words']);
  });
});

describe('summaryText', () => {
  it('renders one fact per line, omitting zero-valued optionals', () => {
    // a connected pair → zero orphans, so only the always-present card + word lines (plus the connector line).
    const s = boardSummary([card('a', 'one two'), card('b', 'three four'), conn('e', 'a', 'b')]);
    expect(summaryText(s)).toBe('2 cards\n1 connector\n4 words'); // no media/due/progress/orphan lines
  });

  it('includes the optional lines when non-zero + a title header', () => {
    const s = boardSummary([
      card('a', 'goal one', { dueDate: Date.UTC(2027, 0, 1), metric: { current: 100, target: 100 } }),
      card('b', 'floating'),
    ]);
    expect(summaryText(s, 'My Board')).toBe('My Board\n\n2 cards\n3 words\n1 with a due date\n1/1 goals complete (100% avg)\n2 unconnected');
  });
});
