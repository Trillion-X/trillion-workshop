// packages/group/read-data/board-mentions.test.ts
import { describe, it, expect } from 'vitest';
import { unlinkedMentions, unlinkedMentionsFrom, cardsWithUnlinkedMentions, boardHasUnlinkedMentions } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-mentions.ts';
import type { BoardItem } from './group-board-model';

const card = (memberId: string, text: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text, extra: {} } as unknown as BoardItem);

describe('unlinkedMentions', () => {
  it('flags a card whose prose names another card title without a [[link]]', () => {
    const items = [card('b', 'Buy a house'), card('a', 'Plan\nwe should buy a house soon')];
    expect(unlinkedMentions(items)).toEqual([{ from: 'a', to: 'b', title: 'Buy a house' }]);
  });

  it('does NOT flag a mention that is already a [[wikilink]]', () => {
    const items = [card('b', 'Buy a house'), card('a', 'Plan\nwe should [[Buy a house]] soon')];
    expect(unlinkedMentions(items)).toEqual([]);
  });

  it('does not double-report when a card both links AND names the title in prose', () => {
    const items = [card('b', 'Buy a house'), card('a', '[[Buy a house]] and also buy a house later')];
    expect(unlinkedMentions(items)).toEqual([]); // pair already linked → suggestion suppressed
  });

  it('matches whole phrases only — "house" does not match inside "housewarming"', () => {
    const items = [card('b', 'house'), card('a', 'Plan a housewarming party')];
    expect(unlinkedMentions(items)).toEqual([]);
  });

  it('a multi-word title must appear contiguously', () => {
    const items = [card('b', 'buy a house'), card('a', 'buy a big house')];
    expect(unlinkedMentions(items)).toEqual([]); // "buy a house" not contiguous in "buy a big house"
  });

  it('is case-insensitive and punctuation-tolerant', () => {
    const items = [card('b', 'Buy a House'), card('a', 'Remember: buy a house.')];
    expect(unlinkedMentions(items)).toEqual([{ from: 'a', to: 'b', title: 'Buy a House' }]);
  });

  it('never flags a card mentioning its own title', () => {
    const items = [card('a', 'Buy a house\nreminder: buy a house tomorrow')];
    expect(unlinkedMentions(items)).toEqual([]);
  });

  it('emits one mention per from→to pair even with repeated mentions', () => {
    const items = [card('b', 'Buy a house'), card('a', 'buy a house, then buy a house again, buy a house')];
    expect(unlinkedMentions(items)).toEqual([{ from: 'a', to: 'b', title: 'Buy a house' }]);
  });
});

describe('selectors', () => {
  const items = [
    card('goal', 'Buy a house'),
    card('save', 'Save money'),
    card('a', 'To buy a house I must save money first'), // mentions both goal + save
    card('b', 'random unrelated note'),
  ];
  it('unlinkedMentionsFrom lists a card distinct mentioned titles', () => {
    expect(unlinkedMentionsFrom(items, 'a').sort()).toEqual(['Buy a house', 'Save money']);
    expect(unlinkedMentionsFrom(items, 'b')).toEqual([]);
  });
  it('cardsWithUnlinkedMentions is the sorted set of mentioning cards', () => {
    expect(cardsWithUnlinkedMentions(items)).toEqual(['a']);
  });
  it('boardHasUnlinkedMentions gates the affordance', () => {
    expect(boardHasUnlinkedMentions(items)).toBe(true);
    expect(boardHasUnlinkedMentions([card('x', 'lonely')])).toBe(false);
  });
});
