// packages/group/do-work/board-tag-canonicalize.test.ts
import { describe, it, expect } from 'vitest';
import { canonicalTagMap, canonicalizeTags, tagsEqual } from 'trillion-workshop/tools/organize-the-sidebar/do-work/board-tag-canonicalize.ts';
import type { BoardItem } from '../read-data/group-board-model';

const card = (memberId: string, tags: string[]): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text: '', extra: { tags } } as unknown as BoardItem);

describe('canonicalTagMap', () => {
  it('maps every variant to the MOST-USED spelling in the group', () => {
    // 'todo' on 2 cards, 'to-do' on 1, 'To Do' on 1 → canonical = 'todo'.
    const items = [card('a', ['todo']), card('b', ['todo']), card('c', ['to-do']), card('d', ['To Do'])];
    const map = canonicalTagMap(items);
    expect(map.get('todo')).toBe('todo');
    expect(map.get('to-do')).toBe('todo');
    expect(map.get('to do')).toBe('todo'); // normTag('To Do') === 'to do'
  });

  it('breaks a count tie alphabetically', () => {
    // 'to-do' and 'todo' each on one card → tie → alpha-first is 'to-do'.
    const items = [card('a', ['todo']), card('b', ['to-do'])];
    expect(canonicalTagMap(items).get('todo')).toBe('to-do');
  });

  it('a tag with no near-duplicate is absent (left untouched)', () => {
    const items = [card('a', ['design']), card('b', ['design'])];
    expect(canonicalTagMap(items).size).toBe(0);
  });
});

describe('canonicalizeTags', () => {
  const map = new Map([['to do', 'todo'], ['to-do', 'todo']]);

  it('rewrites a variant to its canonical spelling', () => {
    expect(canonicalizeTags(['To Do', 'design'], map)).toEqual(['todo', 'design']);
  });

  it('collapses a card carrying two spellings of one intent into a single tag', () => {
    expect(canonicalizeTags(['to-do', 'To Do'], map)).toEqual(['todo']);
  });

  it('leaves an untouched tag alone and preserves order', () => {
    expect(canonicalizeTags(['design', 'todo', 'ship'], map)).toEqual(['design', 'todo', 'ship']);
  });

  it('a card with no mapped tag is unchanged', () => {
    expect(canonicalizeTags(['design', 'ship'], map)).toEqual(['design', 'ship']);
  });
});

describe('tagsEqual', () => {
  it('detects changed vs unchanged lists (lets a batch skip a no-op card)', () => {
    expect(tagsEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(tagsEqual(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(tagsEqual(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('end-to-end: map + rewrite unifies a fragmented board', () => {
  it('every card lands on the canonical spelling, non-fragmented tags untouched', () => {
    const items = [
      card('a', ['todo', 'design']), card('b', ['todo']), card('c', ['to-do']), card('d', ['To Do', 'design']),
    ];
    const map = canonicalTagMap(items); // canonical 'todo' (2 cards)
    const rewritten = items.map((it) => canonicalizeTags((it.extra as { tags: string[] }).tags, map));
    expect(rewritten).toEqual([['todo', 'design'], ['todo'], ['todo'], ['todo', 'design']]);
  });
});
