// packages/group/do-work/board-tag-hygiene.test.ts
import { describe, it, expect } from 'vitest';
import {
  looseTagKey,
  tagUsage,
  singletonTags,
  cardsWithSingletonTag,
  nearDuplicateTagGroups,
  cardsWithFragmentedTag,
  boardHasFragmentedTags,
  tagHygieneText,
} from 'trillion-workshop/tools/organize-the-sidebar/do-work/board-tag-hygiene.ts';
import type { BoardItem } from '../read-data/group-board-model';

const card = (memberId: string, tags: string[]): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text: '', extra: { tags } } as unknown as BoardItem);

describe('looseTagKey', () => {
  it('strips every non-alphanumeric so punctuation/spacing variants collapse', () => {
    expect(looseTagKey('to-do')).toBe('todo');
    expect(looseTagKey('to do')).toBe('todo');
    expect(looseTagKey('todo')).toBe('todo');
  });
});

describe('tagUsage', () => {
  it('counts DISTINCT cards per normalized tag, first-seen display kept', () => {
    const items = [card('a', ['Design']), card('b', ['design']), card('c', ['#design'])];
    const u = tagUsage(items).get('design')!;
    expect(u.tag).toBe('Design'); // first-seen spelling
    expect(u.count).toBe(3);
    expect(u.cardIds).toEqual(['a', 'b', 'c']);
  });

  it('de-dupes a repeated tag WITHIN one card', () => {
    const u = tagUsage([card('a', ['todo', 'todo', 'ToDo'])]).get('todo')!;
    expect(u.count).toBe(1);
    expect(u.cardIds).toEqual(['a']);
  });
});

describe('singletonTags + cardsWithSingletonTag', () => {
  it('a tag on exactly one card is a one-off', () => {
    const items = [card('a', ['todo', 'stray']), card('b', ['todo'])];
    expect(singletonTags(items)).toEqual(['stray']); // todo is on 2 cards, not a singleton
    expect(cardsWithSingletonTag(items)).toEqual(['a']);
  });

  it('no singletons when every tag is shared', () => {
    expect(singletonTags([card('a', ['x']), card('b', ['x'])])).toEqual([]);
  });
});

describe('nearDuplicateTagGroups', () => {
  it('groups distinct spellings that collapse to one loose key', () => {
    const items = [card('a', ['to-do']), card('b', ['todo']), card('c', ['To Do']), card('d', ['done'])];
    const groups = nearDuplicateTagGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].looseKey).toBe('todo');
    expect(groups[0].tags).toEqual(['To Do', 'to-do', 'todo']); // sorted display spellings
    expect(groups[0].cardIds).toEqual(['a', 'b', 'c']); // union across the group, sorted
  });

  it('does NOT flag a single spelling (case-only variants are the SAME tag, not a fragmentation)', () => {
    // 'Todo' and 'todo' normalize to one key → not two distinct spellings → no group.
    expect(nearDuplicateTagGroups([card('a', ['Todo']), card('b', ['todo'])])).toHaveLength(0);
  });

  it('excludes a loose key shorter than 2 chars (a stray c# is not a duplicate of c)', () => {
    expect(nearDuplicateTagGroups([card('a', ['c#']), card('b', ['c'])])).toHaveLength(0);
  });

  it('cardsWithFragmentedTag + boardHasFragmentedTags reflect the groups', () => {
    const items = [card('a', ['to-do']), card('b', ['todo']), card('c', ['clean'])];
    expect(cardsWithFragmentedTag(items)).toEqual(['a', 'b']);
    expect(boardHasFragmentedTags(items)).toBe(true);
    expect(boardHasFragmentedTags([card('a', ['x']), card('b', ['y'])])).toBe(false);
  });
});

describe('tagHygieneText', () => {
  it('reports near-duplicate groups then one-offs', () => {
    const items = [card('a', ['to-do', 'stray']), card('b', ['todo']), card('c', ['To Do'])];
    const text = tagHygieneText(items, 'Tags');
    expect(text).toBe(
      [
        '# Tags',
        '',
        '## Near-duplicate tags (1)',
        '- To Do / to-do / todo — 3 cards, one intent',
        '',
        '## One-off tags (1)',
        '- stray',
      ].join('\n'),
    );
  });

  it('honest empty state on a clean taxonomy', () => {
    expect(tagHygieneText([card('a', ['x']), card('b', ['x'])])).toBe('No tag issues');
  });
});
