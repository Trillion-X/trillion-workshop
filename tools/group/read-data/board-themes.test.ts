// packages/group/read-data/board-themes.test.ts
import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import {
  boardThemes,
  topTheme,
  cardIdsForTopTheme,
  boardHasThemes,
  themesReducedTable,
  themesText,
  cardTerms,
  DEFAULT_STOPWORDS,
} from './board-themes';

const card = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId }, kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text, extra: {} } as unknown as BoardItem);

const connector = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId }, kind: 'connector', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text, extra: { fromMemberId: 'a', toMemberId: 'b' } } as unknown as BoardItem);

const furniture = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId }, kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text, extra: { regionHeading: true } } as unknown as BoardItem);

describe('board-themes', () => {
  it('counts a term once per card (document frequency), not per mention', () => {
    const items = [
      card('c1', 'Deadline deadline DEADLINE for the launch'), // 3 mentions, 1 card
      card('c2', 'Move the deadline earlier'),
      card('c3', 'nothing relevant'),
    ];
    const themes = boardThemes(items);
    const deadline = themes.find((t) => t.term === 'deadline');
    expect(deadline).toBeDefined();
    expect(deadline!.cardCount).toBe(2); // two cards, not four mentions
    expect(deadline!.cardIds).toEqual(['c1', 'c2']);
  });

  it('only counts terms that RECUR across ≥2 cards (a one-off word is not a theme)', () => {
    const items = [card('c1', 'unicorn design'), card('c2', 'design system')];
    const terms = boardThemes(items).map((t) => t.term);
    expect(terms).toContain('design'); // on both cards
    expect(terms).not.toContain('unicorn'); // only one card
    expect(terms).not.toContain('system');
  });

  it('ranks by card-count desc then term asc', () => {
    const items = [
      card('c1', 'design deadline'),
      card('c2', 'design deadline'),
      card('c3', 'design review'),
      card('c4', 'review'),
    ];
    // design: 3 cards, deadline: 2, review: 2 -> design first, then deadline before review (alpha tie)
    expect(boardThemes(items).map((t) => `${t.term}:${t.cardCount}`)).toEqual([
      'design:3',
      'deadline:2',
      'review:2',
    ]);
  });

  it('themesReducedTable projects the themes into the shared ReducedTable shape (one clickable group per term)', () => {
    const items = [
      card('c1', 'design deadline'),
      card('c2', 'design deadline'),
      card('c3', 'design review'),
      card('c4', 'review'),
    ];
    const table = themesReducedTable(items);
    expect(table.sections).toHaveLength(1);
    expect(table.sections[0]).toMatchObject({ key: 'themes', title: 'Recurring themes' });
    expect(table.sections[0].groups).toEqual([
      { key: 'theme:design', label: 'design', detail: '3', cardIds: ['c1', 'c2', 'c3'] },
      { key: 'theme:deadline', label: 'deadline', detail: '2', cardIds: ['c1', 'c2'] },
      { key: 'theme:review', label: 'review', detail: '2', cardIds: ['c3', 'c4'] },
    ]);
    // no recurring term → no section (the panel then renders its honest empty state)
    expect(themesReducedTable([card('c1', 'solo idea')]).sections).toEqual([]);
    expect(themesReducedTable([]).sections).toEqual([]);
  });

  it('drops stopwords and short tokens', () => {
    const items = [card('c1', 'the and for a b c'), card('c2', 'the and for a b c')];
    // every word is a stopword or < 3 chars -> no themes
    expect(boardThemes(items)).toEqual([]);
  });

  it('excludes connectors and furniture from the corpus', () => {
    const items = [
      card('c1', 'roadmap planning'),
      connector('e1', 'roadmap roadmap roadmap'), // must NOT contribute
      furniture('h1', 'roadmap roadmap'), // must NOT contribute
    ];
    // 'roadmap' appears on only ONE content card -> not a theme
    expect(boardThemes(items)).toEqual([]);
  });

  it('topTheme + cardIdsForTopTheme surface the biggest shared theme', () => {
    const items = [
      card('c1', 'growth growth'),
      card('c2', 'growth metric'),
      card('c3', 'growth plan'),
      card('c4', 'metric plan'),
    ];
    expect(topTheme(items)!.term).toBe('growth');
    expect(topTheme(items)!.cardCount).toBe(3);
    expect(cardIdsForTopTheme(items)).toEqual(['c1', 'c2', 'c3']);
  });

  it('empty / no-theme board: null top, empty select, false gate, honest text', () => {
    const items = [card('c1', 'alpha'), card('c2', 'beta')];
    expect(topTheme(items)).toBeNull();
    expect(cardIdsForTopTheme(items)).toEqual([]);
    expect(boardHasThemes(items)).toBe(false);
    expect(themesText(items)).toBe('## Recurring themes\n- No recurring themes');
  });

  it('themesText lists themes with a title and pluralizes', () => {
    const items = [card('c1', 'design deadline'), card('c2', 'design deadline'), card('c3', 'design')];
    expect(themesText(items, 'Board')).toBe(
      '# Board\n\n## Recurring themes\n- design — 3 cards\n- deadline — 2 cards',
    );
    expect(boardHasThemes(items)).toBe(true);
  });

  it('respects injected options: custom stopwords, minCards, limit', () => {
    const items = [
      card('c1', 'design deadline review'),
      card('c2', 'design deadline review'),
      card('c3', 'design'),
    ];
    // custom stopword removes 'design'; minCards 2 keeps deadline+review; limit 1 keeps the top
    const themes = boardThemes(items, { stopwords: new Set(['design']), minCards: 2, limit: 1 });
    expect(themes.length).toBe(1);
    expect(themes[0].term).toBe('deadline'); // deadline before review by alpha tie at 2 cards each
  });

  it('cardTerms dedupes and filters; DEFAULT_STOPWORDS is populated', () => {
    expect([...cardTerms('Plan plan PLAN the a design')].sort()).toEqual(['design', 'plan']);
    expect(DEFAULT_STOPWORDS.has('the')).toBe(true);
    expect(DEFAULT_STOPWORDS.has('design')).toBe(false);
  });

  it('symbol-bearing technical terms (C++/C#/F#) survive as themselves (Codex finding 4)', () => {
    // trailing +/# runs attach to the token; a symbolic token is exempt from min-length ("c#" is deliberate).
    expect([...cardTerms('Learn C++ and c# properly')].sort()).toEqual(['c#', 'c++', 'learn', 'properly']);
    // an INFIX + is an operator, not a name: a+b still splits (and 1-char pieces drop by min-length).
    expect([...cardTerms('compute a+b now')].sort()).toEqual(['compute', 'now']);
    // themes end-to-end: c++ recurring on 2 cards is a real theme.
    const items = [card('c1', 'Refactor the C++ engine'), card('c2', 'c++ build broke')];
    expect(boardThemes(items).map((t) => t.term)).toContain('c++');
  });
});
