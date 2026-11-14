import { describe, expect, it } from 'vitest';
import { similarIds } from 'trillion-workshop/tools/organize-the-sidebar/show/item-similarity.ts';
import { itemTags } from 'trillion-workshop/tools/organize-the-sidebar/show/item-tags.ts';
import { itemFillColor, setStackFill, emptyStack } from 'trillion-workshop/tools/organize-the-sidebar/show/item-fill.ts';
import type { BoardItem } from '../read-data/group-board-model';

const REGISTRY = { family: 'test.layers', parts: {} };
const REGION = { family: 'test.board', parts: {} };
/** Build an item carrying a real solid-fill visualLayerStack (so itemFillColor reads it). */
function filledItem(id: string, color: string | null): BoardItem {
  return {
    memberId: id,
    nodeRef: { family: 'test.item', parts: { id } },
    kind: 'note',
    x: 0,
    y: 0,
    w: 100,
    h: 60,
    extra: { visualLayerStack: setStackFill(emptyStack(REGION), color, REGISTRY) },
  } as BoardItem;
}

function item(p: { id: string; kind?: string; tags?: string[] }): BoardItem {
  return {
    memberId: p.id,
    nodeRef: { family: 'test.item', parts: { id: p.id } },
    kind: p.kind ?? 'note',
    x: 0,
    y: 0,
    w: 100,
    h: 60,
    extra: p.tags ? { tags: p.tags } : {},
  } as BoardItem;
}

describe('similarIds', () => {
  const byKind = (i: BoardItem) => i.kind;
  const byTag = (i: BoardItem) => itemTags(i);

  it('same-kind: selects every item of the anchor kind, excludes other kinds', () => {
    const items = [item({ id: 'a', kind: 'note' }), item({ id: 'b', kind: 'note' }), item({ id: 'c', kind: 'image' })];
    expect(similarIds(items, 'a', byKind).sort()).toEqual(['a', 'b']);
    // anchor an image → just the image.
    expect(similarIds(items, 'c', byKind)).toEqual(['c']);
  });

  it('same-tag: selects items sharing ANY tag with the anchor (intersection)', () => {
    const items = [
      item({ id: 'a', tags: ['idea', 'red'] }),
      item({ id: 'b', tags: ['red'] }), // shares 'red'
      item({ id: 'c', tags: ['idea'] }), // shares 'idea'
      item({ id: 'd', tags: ['blue'] }), // disjoint
      item({ id: 'e' }), // untagged
    ];
    expect(similarIds(items, 'a', byTag).sort()).toEqual(['a', 'b', 'c']);
  });

  it('anchor with no keys → just the anchor (nothing to match on)', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' })]; // no tags
    expect(similarIds(items, 'a', byTag)).toEqual(['a']);
  });

  it('missing anchor → empty', () => {
    expect(similarIds([item({ id: 'a' })], 'zzz', byKind)).toEqual([]);
  });

  it('same-fill (#131): groups by the solid fill colour via itemFillColor as keyOf — zero engine change', () => {
    const byFill = (i: BoardItem) => itemFillColor(i) ?? '';
    const items = [
      filledItem('a', '#ffffff'),
      filledItem('b', '#ffffff'), // same white
      filledItem('c', '#000000'), // black
      filledItem('d', null), // no fill → '' → never groups
    ];
    expect(similarIds(items, 'a', byFill).sort()).toEqual(['a', 'b']);
    expect(similarIds(items, 'd', byFill)).toEqual(['d']); // unfilled anchor → just itself
  });

  it('is GENERIC over the criterion — a synthetic keyOf the board never coded still works (L069 emergence)', () => {
    // Criterion the engine has zero knowledge of: "shares the first letter of the id".
    const items = [item({ id: 'apple' }), item({ id: 'apricot' }), item({ id: 'banana' })];
    const byFirstLetter = (i: BoardItem) => i.memberId[0];
    expect(similarIds(items, 'apple', byFirstLetter).sort()).toEqual(['apple', 'apricot']);
  });
});
