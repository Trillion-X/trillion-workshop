import { describe, it, expect, beforeEach } from 'vitest';
import {
  addBasketPick,
  readBasket,
  removeBasketPick,
  clearBasket,
  basketPickCount,
  basketItemCount,
  basketBoardCount,
  basketToCollection,
  basketToShareCapsule,
  basketPickFromSelection,
} from './collection-basket';
import { decodeCapsuleText, encodeCapsuleText } from '../read-data/share-capsule';

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ memberId: `m${i}`, kind: 'note', x: i * 10, y: 0, w: 100, h: 60, text: `n${i}` }));

beforeEach(() => clearBasket()); // the basket is a module singleton — reset between tests

describe('basketToShareCapsule — several boards, one link (R12)', () => {
  it('turns each pick into a scoped board in one multi-board capsule', () => {
    addBasketPick(basketPickFromSelection('b1', 'Roadmap', items(3), ['m0', 'm1']));
    addBasketPick(basketPickFromSelection('b2', 'Ideas', items(2), ['m0']));
    const capsule = basketToShareCapsule('My set');
    expect(capsule.boards.map((b) => b.boardId)).toEqual(['b1', 'b2']);
    expect(capsule.boards.map((b) => b.title)).toEqual(['Roadmap', 'Ideas']);
    // each board keeps only its selected items (scope = selection)
    expect(capsule.boards[0].items.map((i) => i.memberId)).toEqual(['m0', 'm1']);
    expect(capsule.boards[1].items.map((i) => i.memberId)).toEqual(['m0']);
  });

  it('round-trips through a self-contained link', () => {
    addBasketPick(basketPickFromSelection('b1', 'A', items(2), ['m0']));
    addBasketPick(basketPickFromSelection('b2', 'B', items(2), ['m1']));
    const capsule = basketToShareCapsule('Two boards');
    expect(decodeCapsuleText(encodeCapsuleText(capsule))).toEqual(capsule);
  });

  it('empty basket → empty capsule (no boards)', () => {
    expect(basketToShareCapsule('nothing').boards).toEqual([]);
  });
});

describe('collection-basket — accumulate cross-board selections into one collection (R5)', () => {
  it('starts empty', () => {
    expect(readBasket()).toEqual([]);
    expect(basketPickCount()).toBe(0);
    expect(basketItemCount()).toBe(0);
    expect(basketBoardCount()).toBe(0);
  });

  it('adds picks and reports item + board counts', () => {
    addBasketPick(basketPickFromSelection('b1', 'Roadmap', items(3), ['m0', 'm1']));
    addBasketPick(basketPickFromSelection('b2', 'Ideas', items(2), ['m0']));
    expect(basketPickCount()).toBe(2);
    expect(basketItemCount()).toBe(3); // 2 + 1 selected
    expect(basketBoardCount()).toBe(2); // two distinct source boards
  });

  it('an empty selection is ignored (nothing to add)', () => {
    addBasketPick(basketPickFromSelection('b1', 'Roadmap', items(3), []));
    expect(basketPickCount()).toBe(0);
  });

  it('two picks from the SAME board count as one source board', () => {
    addBasketPick(basketPickFromSelection('b1', 'Roadmap', items(3), ['m0']));
    addBasketPick(basketPickFromSelection('b1', 'Roadmap', items(3), ['m1']));
    expect(basketPickCount()).toBe(2);
    expect(basketBoardCount()).toBe(1);
  });

  it('removeBasketPick drops one; out-of-range is a no-op', () => {
    addBasketPick(basketPickFromSelection('b1', 'A', items(2), ['m0']));
    addBasketPick(basketPickFromSelection('b2', 'B', items(2), ['m1']));
    removeBasketPick(5); // no-op
    expect(basketPickCount()).toBe(2);
    removeBasketPick(0);
    expect(basketPickCount()).toBe(1);
    expect(readBasket()[0].boardId).toBe('b2');
  });

  it('basketToCollection merges the whole basket into ONE template (titled sections by default)', () => {
    addBasketPick(basketPickFromSelection('b1', 'Roadmap', items(2), ['m0', 'm1']));
    addBasketPick(basketPickFromSelection('b2', 'Ideas', items(1), ['m0']));
    const tpl = basketToCollection('My mashup', 'mashup-1');
    expect(tpl.id).toBe('mashup-1');
    const sections = tpl.items.filter((i) => i.kind === 'section');
    expect(sections.map((s) => s.text)).toEqual(['Roadmap', 'Ideas']); // provenance sections
    // does NOT auto-clear — the caller clears after a successful save.
    expect(basketPickCount()).toBe(2);
  });

  it('sectionsByLabel can be turned OFF for a flat merge', () => {
    addBasketPick(basketPickFromSelection('b1', 'Roadmap', items(2), ['m0', 'm1']));
    const tpl = basketToCollection('Flat', 'flat', { sectionsByLabel: false });
    expect(tpl.items.filter((i) => i.kind === 'section')).toHaveLength(0);
  });

  it('clearBasket empties it', () => {
    addBasketPick(basketPickFromSelection('b1', 'A', items(2), ['m0']));
    clearBasket();
    expect(basketPickCount()).toBe(0);
  });
});
