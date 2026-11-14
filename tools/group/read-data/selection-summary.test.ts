// packages/group/read-data/selection-summary.test.ts
import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import { boardSummary } from './board-summary';
import { selectionSummary, summaryChips } from './selection-summary';

// minimal card factory — memberId + kind + text, plus optional metric/dueDate in extra.
function card(id: string, text: string, extra?: Record<string, unknown>): BoardItem {
  return { memberId: id, kind: 'note', x: 0, y: 0, w: 100, h: 60, text, extra } as unknown as BoardItem;
}
function media(id: string): BoardItem {
  return { memberId: id, kind: 'media', x: 0, y: 0, w: 100, h: 60, text: '', extra: {} } as unknown as BoardItem;
}
const metric = (current: number, target: number) => ({ metric: { current, target } });

const ITEMS: BoardItem[] = [
  card('a', 'one two three', metric(10, 10)),   // complete, 3 words
  card('b', 'four five', metric(2, 10)),          // 20%, 2 words
  card('c', 'lonely', { dueDate: 1_800_000_000_000 }), // dated (epoch-ms), 1 word
  media('d'),                                      // media card
  card('e', 'not selected at all here'),           // outside selection
];

describe('selectionSummary — scopes the census to the selected subset', () => {
  it('counts only selected items and reuses boardSummary verbatim (SSOT)', () => {
    const sel = selectionSummary(ITEMS, ['a', 'b', 'c', 'd']);
    expect(sel.count).toBe(4);
    // identical to running boardSummary over exactly that subset — no divergent census logic
    const subset = ITEMS.filter((i) => ['a', 'b', 'c', 'd'].includes(i.memberId));
    expect(sel.summary).toEqual(boardSummary(subset));
    expect(sel.summary.cards).toBe(4);
    expect(sel.summary.media).toBe(1);
    expect(sel.summary.withProgress).toBe(2);
    expect(sel.summary.complete).toBe(1);
    expect(sel.summary.avgProgress).toBe(60); // (100 + 20) / 2
    expect(sel.summary.withDueDate).toBe(1);
  });

  it('ignores ids that match no item (fail-open, never throws)', () => {
    const sel = selectionSummary(ITEMS, ['a', 'ghost', 'also-missing']);
    expect(sel.count).toBe(1);
    expect(sel.summary.cards).toBe(1);
  });

  it('empty selection yields count 0 and no chips', () => {
    const sel = selectionSummary(ITEMS, []);
    expect(sel.count).toBe(0);
    expect(sel.chips).toEqual([]);
  });
});

describe('summaryChips — DATA-driven projection, omits zero facts', () => {
  it('emits present facts in spec order with human labels', () => {
    const sel = selectionSummary(ITEMS, ['a', 'b', 'c', 'd']);
    const byKey = Object.fromEntries(sel.chips.map((c) => [c.key, c.label]));
    expect(byKey.cards).toBe('4 cards');
    expect(byKey.media).toBe('1 media');
    expect(byKey.progress).toBe('1/2 done');
    expect(byKey.avg).toBe('60% avg');
    expect(byKey.due).toBe('1 dated');
    // zero-valued facts are omitted entirely
    expect(sel.chips.some((c) => c.key === 'orphans')).toBe(false);
    expect(sel.chips.some((c) => c.key === 'sections')).toBe(false);
  });

  it('singular vs plural for a one-card selection', () => {
    const chips = summaryChips(boardSummary([card('x', 'solo word')]));
    expect(chips.find((c) => c.key === 'cards')?.label).toBe('1 card');
    expect(chips.find((c) => c.key === 'words')?.label).toBe('2 words');
  });
});
