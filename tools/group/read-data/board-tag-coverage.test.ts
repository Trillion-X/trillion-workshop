// packages/group/read-data/board-tag-coverage.test.ts
import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import {
  taggedCardIds,
  untaggedCardIds,
  boardHasTagGaps,
  tagCoverage,
  tagCoverageText,
} from './board-tag-coverage';

const card = (memberId: string, tags?: string[]): BoardItem =>
  ({ memberId, nodeRef: { id: memberId }, kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text: memberId, extra: tags ? { tags } : {} } as unknown as BoardItem);

const connector = (memberId: string, tags: string[]): BoardItem =>
  ({ memberId, nodeRef: { id: memberId }, kind: 'connector', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text: '', extra: { fromMemberId: 'a', toMemberId: 'b', tags } } as unknown as BoardItem);

const furniture = (memberId: string, tags: string[]): BoardItem =>
  ({ memberId, nodeRef: { id: memberId }, kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text: memberId, extra: { regionHeading: true, tags } } as unknown as BoardItem);

describe('board-tag-coverage', () => {
  it('partitions cards into tagged / untagged (sorted)', () => {
    const items = [card('c2', ['urgent']), card('c1'), card('c3', ['idea', 'urgent']), card('c4')];
    expect(taggedCardIds(items)).toEqual(['c2', 'c3']);
    expect(untaggedCardIds(items)).toEqual(['c1', 'c4']);
  });

  it('boardHasTagGaps needs both a tagged AND an untagged card', () => {
    expect(boardHasTagGaps([card('c1', ['a']), card('c2')])).toBe(true);
    expect(boardHasTagGaps([card('c1', ['a']), card('c2', ['b'])])).toBe(false); // all tagged
    expect(boardHasTagGaps([card('c1'), card('c2')])).toBe(false); // none tagged
    expect(boardHasTagGaps([])).toBe(false);
  });

  it('excludes connectors and furniture from the partition and the gate', () => {
    const items = [card('c1', ['a']), connector('e1', ['edge']), furniture('h1', ['head'])];
    expect(taggedCardIds(items)).toEqual(['c1']);
    expect(untaggedCardIds(items)).toEqual([]);
    expect(boardHasTagGaps(items)).toBe(false); // only one content card, tagged
  });

  it('tagCoverage counts tagged/untagged + distinct tags (case-insensitive)', () => {
    const items = [card('c1', ['Urgent']), card('c2', ['urgent', 'idea']), card('c3')];
    expect(tagCoverage(items)).toEqual({ taggedCount: 2, untaggedCount: 1, distinctTags: 2 }); // Urgent==urgent
  });

  it('tagCoverageText: tallies + distinct, honest empty, pluralize', () => {
    const items = [card('c1', ['a']), card('c2'), card('c3')];
    expect(tagCoverageText(items, 'Board')).toBe(
      '# Board\n\n## Tag coverage\n- Tagged: 1 card\n- Untagged: 2 cards\n- Distinct tags: 1',
    );
    expect(tagCoverageText([])).toBe('## Tag coverage\n- No cards');
  });

  it('a fully-tagged board: no gap, zero untagged', () => {
    const items = [card('c1', ['a']), card('c2', ['b'])];
    expect(untaggedCardIds(items)).toEqual([]);
    expect(boardHasTagGaps(items)).toBe(false);
    expect(tagCoverage(items).untaggedCount).toBe(0);
  });
});
