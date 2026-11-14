// packages/group/read-data/board-entity-index.test.ts
import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import {
  boardEntityIndex,
  boardEntityValues,
  cardIdsWithEntity,
  boardHasEntities,
  entityIndexText,
} from './board-entity-index';

const card = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId }, kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text, extra: {} } as unknown as BoardItem);

const connector = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId }, kind: 'connector', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text, extra: { fromMemberId: 'a', toMemberId: 'b' } } as unknown as BoardItem);

const furniture = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId }, kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text, extra: { regionHeading: true } } as unknown as BoardItem);

describe('board-entity-index', () => {
  it('collects every URL across the board with the cards carrying it (document frequency)', () => {
    const items = [
      card('c1', 'See https://example.com and https://example.com again'), // same URL twice, one card
      card('c2', 'Docs at https://example.com'),
      card('c3', 'Ref www.other.org here'),
      card('c4', 'no links here'),
    ];
    const idx = boardEntityIndex(items, 'url');
    const ex = idx.find((r) => r.value === 'https://example.com')!;
    expect(ex.cardCount).toBe(2); // two cards, not three mentions
    expect(ex.cardIds).toEqual(['c1', 'c2']);
    expect(idx.map((r) => r.value)).toContain('www.other.org');
  });

  it('ranks by card-count desc then value asc', () => {
    const items = [
      card('c1', 'https://a.com https://b.com'),
      card('c2', 'https://a.com'),
      card('c3', 'https://a.com'),
      card('c4', 'https://b.com'),
    ];
    // a.com: 3 cards, b.com: 2 cards
    expect(boardEntityIndex(items, 'url').map((r) => `${r.value}:${r.cardCount}`)).toEqual([
      'https://a.com:3',
      'https://b.com:2',
    ]);
  });

  it('excludes connectors and furniture from the corpus', () => {
    const items = [
      card('c1', 'plain'),
      connector('e1', 'https://edge.com'), // must NOT contribute
      furniture('h1', 'https://heading.com'), // must NOT contribute
    ];
    expect(boardEntityIndex(items, 'url')).toEqual([]);
  });

  it('cardIdsWithEntity + boardHasEntities + empty index', () => {
    const items = [card('c1', 'https://x.com'), card('c2', 'nothing'), card('c3', 'https://y.com https://x.com')];
    expect(cardIdsWithEntity(items, 'url')).toEqual(['c1', 'c3']);
    expect(boardHasEntities(items, 'url')).toBe(true);
    const none = [card('c1', 'nothing'), card('c2', 'here')];
    expect(boardHasEntities(none, 'url')).toBe(false);
    expect(cardIdsWithEntity(none, 'url')).toEqual([]);
  });

  it('entityIndexText: heading + tallies, honest empty, pluralize', () => {
    const items = [card('c1', 'https://a.com'), card('c2', 'https://a.com'), card('c3', 'https://b.com')];
    expect(entityIndexText(items, 'url', 'Links')).toBe(
      '## Links\n- https://a.com — 2 cards\n- https://b.com — 1 card',
    );
    expect(entityIndexText([card('c1', 'x')], 'url', 'Links')).toBe('## Links\n- No links');
  });

  it('boardEntityValues is the flat sorted distinct list', () => {
    const items = [card('c1', 'https://b.com https://a.com'), card('c2', 'https://a.com')];
    // a.com on 2 cards ranks first, then b.com
    expect(boardEntityValues(items, 'url')).toEqual(['https://a.com', 'https://b.com']);
  });

  it('respects limit', () => {
    const items = [
      card('c1', 'https://a.com https://a.com'),
      card('c2', 'https://a.com'),
      card('c3', 'https://b.com'),
    ];
    expect(boardEntityIndex(items, 'url', { limit: 1 }).map((r) => r.value)).toEqual(['https://a.com']);
  });

  // L069 DELETION TEST: the SAME engine indexes a completely different entity kind from a DATA argument alone,
  // ZERO engine change. Emails become a contact sheet; hashtags become a topic index — for free.
  it('is kind-parametric: emails and hashtags emerge from the same engine (deletion test)', () => {
    const items = [
      card('c1', 'ping me at sam@example.com about #launch'),
      card('c2', 'sam@example.com leads #launch and #design'),
      card('c3', 'no entities'),
    ];
    expect(boardEntityIndex(items, 'email').map((r) => `${r.value}:${r.cardCount}`)).toEqual(['sam@example.com:2']);
    expect(boardEntityIndex(items, 'hashtag').map((r) => `${r.value}:${r.cardCount}`)).toEqual([
      '#launch:2',
      '#design:1',
    ]);
    expect(entityIndexText(items, 'email', 'Contacts')).toBe('## Contacts\n- sam@example.com — 2 cards');
    expect(cardIdsWithEntity(items, 'hashtag')).toEqual(['c1', 'c2']);
  });
});
