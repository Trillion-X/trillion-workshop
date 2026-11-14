// packages/group/read-data/box-select.test.ts
//
// Proves b184's spatial box-select: itemsInRect (intersect vs contain modes), worldRectFromScreen (projection
// inverse + any-direction drag), itemsInViewport (select-all-visible via the camera), and invertSelection.

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import type { Camera, Viewport, WorldBox } from 'trillion-workshop/tools/organize-the-sidebar/read-data/viewport-visibility.ts';
import { itemsInRect, worldRectFromScreen, itemsInViewport, invertSelection } from 'trillion-workshop/tools/organize-the-sidebar/read-data/box-select.ts';

const card = (memberId: string, x: number, y: number, w = 100, h = 100): BoardItem =>
  ({ memberId, kind: 'note', x, y, w, h, text: memberId, extra: {}, isSection: false } as unknown as BoardItem);
const rect = (x: number, y: number, w: number, h: number): WorldBox => ({ x, y, w, h });

describe('itemsInRect', () => {
  const items = [card('a', 0, 0), card('b', 200, 0), card('c', 100, 100)]; // a at origin, c sticks past the rect

  it('intersect (default) grabs any overlap; contain grabs only fully-enclosed cards', () => {
    // a rect over [0,0..150,150]: a fully inside, c overlaps but sticks out to (200,200), b far away
    const r = rect(0, 0, 150, 150);
    expect(itemsInRect(items, r).sort()).toEqual(['a', 'c']);        // intersect: a + c
    expect(itemsInRect(items, r, 'contain')).toEqual(['a']);          // contain: only a is fully in (c extends to 200)
  });

  it('touching edges do NOT count as intersect; nothing selected → []', () => {
    expect(itemsInRect(items, rect(100, 0, 50, 50))).toEqual([]); // rect starts exactly at a's right edge
    expect(itemsInRect(items, rect(1000, 1000, 10, 10))).toEqual([]);
  });
});

describe('worldRectFromScreen', () => {
  const cam: Camera = { panX: 100, panY: 50, zoom: 2 };
  it('inverts the board projection (world = (screen - pan) / zoom)', () => {
    // screen box at (300,250) size 200 → world (100,100) size 100 under zoom 2
    expect(worldRectFromScreen({ x: 300, y: 250, w: 200, h: 200 }, cam)).toEqual({ x: 100, y: 100, w: 100, h: 100 });
  });
  it('normalises a negative (up/left) drag to a positive box', () => {
    // dragging from (500,450) up-left by 200 → same world box as above
    expect(worldRectFromScreen({ x: 500, y: 450, w: -200, h: -200 }, cam)).toEqual({ x: 100, y: 100, w: 100, h: 100 });
  });
});

describe('itemsInViewport', () => {
  it('selects the cards currently on-screen under the camera', () => {
    // zoom 1, no pan: viewport [0,0..300,300] world-equals-screen. a(0,0) & c(50,50) visible, b(400,0) off-screen
    const items = [card('a', 0, 0), card('b', 400, 0), card('c', 50, 50)];
    const cam: Camera = { panX: 0, panY: 0, zoom: 1 };
    const view: Viewport = { w: 300, h: 300 };
    expect(itemsInViewport(items, cam, view).sort()).toEqual(['a', 'c']);
  });
});

describe('invertSelection', () => {
  it('returns the ids not currently selected (input order)', () => {
    const items = [card('a', 0, 0), card('b', 0, 0), card('c', 0, 0)];
    expect(invertSelection(items, ['b'])).toEqual(['a', 'c']);
    expect(invertSelection(items, [])).toEqual(['a', 'b', 'c']);
    expect(invertSelection(items, ['a', 'b', 'c'])).toEqual([]);
  });
});
