// packages/group/read-data/board-titles.test.ts
import { describe, it, expect } from 'vitest';
import {
  duplicateTitleGroups,
  shadowedTitleIds,
  ambiguousTitleIds,
  boardHasDuplicateTitles,
  duplicateTitlesText,
} from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-titles.ts';
import { buildTitleIndex, normalizeTitle } from 'trillion-workshop/tools/organize-the-sidebar/read-data/card-references.ts';
import type { BoardItem } from './group-board-model';

const card = (memberId: string, text: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text, extra: {} } as unknown as BoardItem);
const connector = (memberId: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: {} } as unknown as BoardItem);

describe('duplicateTitleGroups', () => {
  it('groups the cards that share a title, memberIds in board order (winner first)', () => {
    const items = [card('a', 'Onboarding\nsome notes'), card('b', 'Pricing'), card('c', 'Onboarding\nother notes')];
    const groups = duplicateTitleGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Onboarding');
    expect(groups[0].key).toBe('onboarding');
    expect(groups[0].memberIds).toEqual(['a', 'c']); // board order → a is the reachable winner
  });

  it('is case/whitespace-insensitive — the same folding as [[link]] resolution', () => {
    const items = [card('a', 'Buy A House'), card('b', 'buy a  house\ndetails')];
    const groups = duplicateTitleGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toEqual(['a', 'b']);
  });

  it('untitled cards (empty / whitespace first line) are NOT a collision', () => {
    const items = [card('a', ''), card('b', '   '), card('c', '\nsecond line only')];
    expect(duplicateTitleGroups(items)).toHaveLength(0);
  });

  it('a connector (no text) never counts as a title', () => {
    const items = [card('a', 'Task'), connector('e1'), card('b', 'Task')];
    const groups = duplicateTitleGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toEqual(['a', 'b']);
  });

  it('three cards with one title → a group of three', () => {
    const items = [card('a', 'Idea'), card('b', 'Idea'), card('c', 'Idea')];
    expect(duplicateTitleGroups(items)[0].memberIds).toEqual(['a', 'b', 'c']);
  });

  it('all-distinct titles → no collisions', () => {
    expect(duplicateTitleGroups([card('a', 'One'), card('b', 'Two'), card('c', 'Three')])).toHaveLength(0);
  });

  it('groups appear in the order each title first shows on the board', () => {
    const items = [card('a', 'Alpha'), card('b', 'Beta'), card('c', 'Beta'), card('d', 'Alpha')];
    expect(duplicateTitleGroups(items).map((g) => g.key)).toEqual(['alpha', 'beta']);
  });
});

describe('shadowedTitleIds (SSOT: the cards [[link]] can never reach)', () => {
  it('is exactly the 2nd-and-later card of every collision, sorted', () => {
    const items = [card('a', 'Idea'), card('b', 'Idea'), card('c', 'Idea'), card('d', 'Other'), card('e', 'Other')];
    expect(shadowedTitleIds(items)).toEqual(['b', 'c', 'e']);
  });

  it('PROOF vs buildTitleIndex — the winner (memberIds[0]) is exactly the card resolution lands on, so every shadowed id resolves to someone else', () => {
    const items = [card('a', 'Onboarding'), card('c', 'Onboarding'), card('b', 'Pricing')];
    const index = buildTitleIndex(items);
    for (const g of duplicateTitleGroups(items)) {
      // the reachable card is the one the live index maps the title to
      expect(index.get(g.key)).toBe(g.memberIds[0]);
      // every shadowed card bears the title yet resolution never returns it
      for (const shadowed of g.memberIds.slice(1)) {
        expect(index.get(normalizeTitle('Onboarding'))).not.toBe(shadowed);
      }
    }
    expect(shadowedTitleIds(items)).toEqual(['c']);
  });

  it('no collisions → no shadowed cards', () => {
    expect(shadowedTitleIds([card('a', 'One'), card('b', 'Two')])).toEqual([]);
  });
});

describe('ambiguousTitleIds + boardHasDuplicateTitles', () => {
  it('ambiguousTitleIds is every card in any collision (winner + shadowed), sorted', () => {
    const items = [card('a', 'Idea'), card('b', 'Idea'), card('c', 'Solo')];
    expect(ambiguousTitleIds(items)).toEqual(['a', 'b']);
  });

  it('boardHasDuplicateTitles gates the affordance', () => {
    expect(boardHasDuplicateTitles([card('a', 'X'), card('b', 'X')])).toBe(true);
    expect(boardHasDuplicateTitles([card('a', 'X'), card('b', 'Y')])).toBe(false);
    expect(boardHasDuplicateTitles([])).toBe(false);
  });
});

describe('duplicateTitlesText', () => {
  it('reports each colliding title with card + unreachable counts', () => {
    const items = [card('a', 'Onboarding'), card('c', 'Onboarding'), card('d', 'Pricing'), card('e', 'Pricing'), card('f', 'Pricing')];
    const text = duplicateTitlesText(items, 'My Board');
    expect(text).toBe(
      [
        '# My Board',
        '',
        '## Duplicate titles (2)',
        '- Onboarding — 2 cards (1 unreachable by [[link]])',
        '- Pricing — 3 cards (2 unreachable by [[link]])',
      ].join('\n'),
    );
  });

  it('honest empty state', () => {
    expect(duplicateTitlesText([card('a', 'One'), card('b', 'Two')])).toBe('No duplicate titles');
  });
});
