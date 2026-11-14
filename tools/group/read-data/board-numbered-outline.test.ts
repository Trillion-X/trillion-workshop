// packages/group/read-data/board-numbered-outline.test.ts
import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import {
  numberedOutline,
  numberOutlineLines,
  numberedOutlineText,
  boardHasOutline,
  outlineNumberOf,
} from './board-numbered-outline';

const card = (memberId: string, text: string, x = 0, y = 0): BoardItem =>
  ({ kind: 'note', memberId, x, y, w: 100, h: 40, text, extra: {} } as unknown as BoardItem);
const conn = (memberId: string, from: string, to: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

describe('numberedOutline carries the card memberId (for jump-to navigation)', () => {
  it('threads each card memberId onto its numbered line, following the connector tree', () => {
    // root a -> children b, c (b to the left of c) ; c -> d
    const items = [
      card('a', 'Root', 0, 0), card('b', 'Child B', 0, 100), card('c', 'Child C', 200, 100), card('d', 'Grandchild', 200, 200),
      conn('e1', 'a', 'b'), conn('e2', 'a', 'c'), conn('e3', 'c', 'd'),
    ];
    const rows = numberedOutline(items);
    expect(rows.map((r) => `${r.number} ${r.memberId}`)).toEqual(['1 a', '1.1 b', '1.2 c', '1.2.1 d']);
    expect(rows.every((r) => typeof r.memberId === 'string')).toBe(true); // every real-board row is a jump target
  });

  it('numberOutlineLines threads memberId when present and omits it for text-parsed lines', () => {
    expect(numberOutlineLines([{ depth: 0, text: 'X', memberId: 'm1' }])[0].memberId).toBe('m1');
    expect(numberOutlineLines([{ depth: 0, text: 'X' }])[0].memberId).toBeUndefined();
  });
});

describe('numberOutlineLines (pure numbering)', () => {
  it('numbers a nested outline 1 / 1.1 / 1.2 / 2', () => {
    const lines = [
      { depth: 0, text: 'A' },
      { depth: 1, text: 'A1' },
      { depth: 1, text: 'A2' },
      { depth: 0, text: 'B' },
      { depth: 1, text: 'B1' },
    ];
    expect(numberOutlineLines(lines).map((l) => `${l.number} ${l.text}`)).toEqual([
      '1 A', '1.1 A1', '1.2 A2', '2 B', '2.1 B1',
    ]);
  });

  it('handles deep nesting + returning to a shallower level', () => {
    const lines = [
      { depth: 0, text: 'A' },
      { depth: 1, text: 'A1' },
      { depth: 2, text: 'A1a' },
      { depth: 1, text: 'A2' }, // back to depth 1 → 1.2, deeper counter reset
      { depth: 2, text: 'A2a' },
    ];
    expect(numberOutlineLines(lines).map((l) => l.number)).toEqual(['1', '1.1', '1.1.1', '1.2', '1.2.1']);
  });

  it('empty → []', () => {
    expect(numberOutlineLines([])).toEqual([]);
  });
});

describe('numberedOutline (over the board connector tree)', () => {
  it('numbers a connector tree: root + its children', () => {
    // a → b, a → c  (a is the root; b above c by y so b=1.1, c=1.2)
    const items = [card('a', 'Root', 0, 0), card('b', 'Child B', 0, 10), card('c', 'Child C', 0, 20), conn('e1', 'a', 'b'), conn('e2', 'a', 'c')];
    expect(numberedOutline(items).map((l) => `${l.number} ${l.text}`)).toEqual(['1 Root', '1.1 Child B', '1.2 Child C']);
  });

  it('a connector-free board is a flat numbered list (each card a root)', () => {
    const items = [card('a', 'One', 0, 0), card('b', 'Two', 0, 10), card('c', 'Three', 0, 20)];
    expect(numberedOutline(items).map((l) => l.number)).toEqual(['1', '2', '3']);
  });

  it('connectors + furniture are not numbered rows', () => {
    const items = [card('a', 'One', 0, 0), conn('e1', 'a', 'a')];
    // self-loop connector is not a card row; only 'a' numbers
    expect(numberedOutline(items).map((l) => l.text)).toEqual(['One']);
  });

  it('boardHasOutline + empty text', () => {
    expect(boardHasOutline([card('a', 'x')])).toBe(true);
    expect(boardHasOutline([])).toBe(false);
    expect(numberedOutlineText([])).toBe('## Outline\n- No cards');
  });

  it('numberedOutlineText indents by depth with the number + a title', () => {
    const items = [card('a', 'Root', 0, 0), card('b', 'Child', 0, 10), conn('e1', 'a', 'b')];
    expect(numberedOutlineText(items, 'Plan')).toBe('# Plan\n\n## Outline\n1 Root\n  1.1 Child');
  });

  it('outlineNumberOf finds a card’s number for a cross-reference', () => {
    const items = [card('a', 'Root', 0, 0), card('b', 'Target', 0, 10), conn('e1', 'a', 'b')];
    expect(outlineNumberOf(items, 'Target')).toBe('1.1');
    expect(outlineNumberOf(items, 'Nope')).toBeNull();
  });
});
