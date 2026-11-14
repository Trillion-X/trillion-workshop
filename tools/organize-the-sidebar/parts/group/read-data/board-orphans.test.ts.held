// packages/group/read-data/board-orphans.test.ts
import { describe, it, expect } from 'vitest';
import { orphanCards, isOrphan } from './board-orphans';
import type { BoardItem } from './group-board-model';

const card = (memberId: string, text = ''): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text, extra: {} } as unknown as BoardItem);
const section = (memberId: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, isSection: true, text: '', extra: {} } as unknown as BoardItem);
const conn = (memberId: string, from: string, to: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

describe('orphanCards', () => {
  it('is empty when every card is connected', () => {
    expect(orphanCards([card('a', 'A'), card('b', 'B'), conn('e', 'a', 'b')])).toEqual([]);
  });

  it('finds cards touched by NO connector and NO reference', () => {
    const items = [
      card('a', 'A'), card('b', 'B'), conn('e', 'a', 'b'), // a,b connected
      card('lonely', 'Lonely'), card('floating', 'Floating'), // orphans
    ];
    expect(orphanCards(items)).toEqual(['floating', 'lonely']);
  });

  it('a card connected only by a typed [[reference]] is NOT an orphan (either direction)', () => {
    const items = [
      card('house', 'Buy a house'),
      card('plan', 'plan for [[Buy a house]]'), // plan → house via reference
      card('real orphan', 'nothing here'),
    ];
    // house is referenced, plan references → both connected; only "real orphan" floats.
    expect(orphanCards(items)).toEqual(['real orphan']);
  });

  it('a card whose only reference is BROKEN is still an orphan (a dangling link connects nothing)', () => {
    expect(orphanCards([card('x', 'want [[Nonexistent]]')])).toEqual(['x']);
  });

  it('connectors and sections are never orphans', () => {
    // a lone connector's endpoints are absent → dangling → dropped; the connector itself is not a content card.
    expect(orphanCards([section('sec'), conn('e', 'ghost1', 'ghost2')])).toEqual([]);
  });
});

describe('isOrphan', () => {
  const items = [card('a', 'A'), card('b', 'B'), conn('e', 'a', 'b'), card('lonely', 'Lonely')];
  it('true for a floating card, false for a connected one', () => {
    expect(isOrphan(items, 'lonely')).toBe(true);
    expect(isOrphan(items, 'a')).toBe(false);
  });
  it('false for a missing id / a connector', () => {
    expect(isOrphan(items, 'nope')).toBe(false);
    expect(isOrphan(items, 'e')).toBe(false);
  });
});
