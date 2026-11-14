// packages/group/read-data/camera-frame.test.ts
//
// Proves b182's frame-to-fit: unionBox, frameCamera (centering + zoom-to-fit + the maxZoom cap + clamps +
// null guards), and the emergent helpers frameAll / frameSelection / frameIsland. Verifies the projection by
// pushing the framed content back through the board's canon (screen = world*zoom + pan) and asserting it lands
// centered within the margins.

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import { unionBox, frameCamera, frameAll, frameSelection, frameIsland } from './camera-frame';
import type { Camera, Viewport, WorldBox } from './viewport-visibility';

const box = (x: number, y: number, w: number, h: number): WorldBox => ({ x, y, w, h });
const card = (memberId: string, x: number, y: number, w = 100, h = 80): BoardItem =>
  ({ memberId, kind: 'note', x, y, w, h, text: memberId, extra: {}, isSection: false } as unknown as BoardItem);
const conn = (memberId: string, from: string, to: string): BoardItem =>
  ({ memberId, kind: 'note', x: 0, y: 0, w: 4, h: 4, extra: { fromMemberId: from, toMemberId: to }, isSection: false } as unknown as BoardItem);
const view: Viewport = { w: 500, h: 500 };
// project a world box to screen under a camera (the board's canon: screen = world*zoom + pan)
const screen = (b: WorldBox, c: Camera) => ({ left: b.x * c.zoom + c.panX, top: b.y * c.zoom + c.panY, right: (b.x + b.w) * c.zoom + c.panX, bottom: (b.y + b.h) * c.zoom + c.panY });

describe('unionBox', () => {
  it('is the tightest box over all boxes; single passes through; empty → null', () => {
    expect(unionBox([box(0, 0, 100, 100), box(200, 50, 100, 100)])).toEqual({ x: 0, y: 0, w: 300, h: 150 });
    expect(unionBox([box(10, 20, 30, 40)])).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(unionBox([])).toBeNull();
  });
});

describe('frameCamera', () => {
  it('zooms out to fit a large box and centers it within the margins', () => {
    const cam = frameCamera([box(0, 0, 2000, 2000)], view, { margin: 40, maxZoom: 1 })!;
    // 420 avail / 2000 = 0.21 zoom
    expect(cam.zoom).toBeCloseTo(0.21, 5);
    const s = screen(box(0, 0, 2000, 2000), cam);
    expect(s.left).toBeCloseTo(40, 4);   // padded by the margin on each side
    expect(s.right).toBeCloseTo(460, 4);
    expect(s.top).toBeCloseTo(40, 4);
    expect(s.bottom).toBeCloseTo(460, 4);
  });

  it('does NOT zoom in past maxZoom for a tiny box (just centers it)', () => {
    const cam = frameCamera([box(0, 0, 100, 100)], view, { margin: 40, maxZoom: 1 })!;
    expect(cam.zoom).toBe(1); // capped, not 4.2
    const s = screen(box(0, 0, 100, 100), cam);
    // centered: a 100px box in a 500px view sits at [200,300]
    expect(s.left).toBeCloseTo(200, 4);
    expect(s.right).toBeCloseTo(300, 4);
  });

  it('clamps to minZoom and returns null on empty / non-positive viewport', () => {
    const huge = frameCamera([box(0, 0, 1_000_000, 1_000_000)], view, { minZoom: 0.05 })!;
    expect(huge.zoom).toBe(0.05);
    expect(frameCamera([], view)).toBeNull();
    expect(frameCamera([box(0, 0, 100, 100)], { w: 0, h: 500 })).toBeNull();
  });
});

describe('frameAll / frameSelection / frameIsland', () => {
  const board = [
    card('a', 0, 0), card('b', 400, 0), card('c', 0, 400),
    card('d', 2000, 2000), card('e', 2200, 2000),
    conn('e1', 'd', 'e'),
  ];

  it('frameAll frames the whole extent; frameSelection frames only the given cards', () => {
    const all = frameAll(board, view)!;
    const sel = frameSelection(board, ['d', 'e'], view)!;
    // the selection of the two far cards zooms in TIGHTER than the whole board (smaller extent → larger zoom)
    expect(sel.zoom).toBeGreaterThan(all.zoom);
    // the framed selection's union is centered
    const s = screen({ x: 2000, y: 2000, w: 300, h: 80 }, sel);
    expect((s.left + s.right) / 2).toBeCloseTo(250, 3); // horizontally centered in the 500 view
  });

  it('frameSelection with no matching ids → null', () => {
    expect(frameSelection(board, ['ghost'], view)).toBeNull();
  });

  it('frameIsland frames the whole connected cluster of a card (composes islandOf)', () => {
    // d & e are one island (connected by e1); framing from d equals framing selection [d,e]
    const island = frameIsland(board, 'd', view)!;
    const sel = frameSelection(board, ['d', 'e'], view)!;
    expect(island).toEqual(sel);
  });
});
