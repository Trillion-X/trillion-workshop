// packages/group/show/snap-guides.test.ts
//
// Pure proof of the alignment-snap primitive — rectangle edge/center coincidence
// within a tolerance. No DOM, no engine: deterministic geometry truth.

import { describe, it, expect } from 'vitest';
import { computeSnap, computeResizeSnap, snapRectToGrid, type SnapRect } from './snap-guides';

// A fixed peer whose lines are x∈{100,150,200}, y∈{100,150,200}.
const P: SnapRect = { x: 100, y: 100, w: 100, h: 100 };
const TH = 6;

describe('computeSnap', () => {
  it('snaps a near LEFT edge onto the peer left and emits a vertical guide there', () => {
    const moving: SnapRect = { x: 103, y: 300, w: 50, h: 50 };
    const r = computeSnap(moving, [P], TH);
    expect(r.dx).toBe(-3); // 100 − 103
    expect(r.dy).toBe(0);
    const v = r.guides.find((g) => g.orient === 'v')!;
    expect(v.pos).toBe(100);
  });

  it('snaps the CENTER-X onto a peer center', () => {
    const moving: SnapRect = { x: 123, y: 300, w: 60, h: 60 }; // centerX = 153
    const r = computeSnap(moving, [P], TH);
    expect(r.dx).toBe(-3); // 150 − 153
    expect(r.guides.some((g) => g.orient === 'v' && g.pos === 150)).toBe(true);
  });

  it('snaps a near RIGHT edge onto the peer right (isolated within threshold)', () => {
    const moving: SnapRect = { x: 160, y: 300, w: 45, h: 45 }; // right = 205
    const r = computeSnap(moving, [P], TH);
    expect(r.dx).toBe(-5); // 200 − 205
    expect(r.guides.some((g) => g.orient === 'v' && g.pos === 200)).toBe(true);
  });

  it('snaps on the Y axis (top edge) → dy + a horizontal guide, no vertical', () => {
    const moving: SnapRect = { x: 300, y: 103, w: 50, h: 50 };
    const r = computeSnap(moving, [P], TH);
    expect(r.dy).toBe(-3);
    expect(r.dx).toBe(0);
    expect(r.guides.length).toBe(1);
    expect(r.guides[0]).toMatchObject({ orient: 'h', pos: 100 });
  });

  it('does NOT snap beyond the threshold (no offset, no guides)', () => {
    const r = computeSnap({ x: 300, y: 300, w: 50, h: 50 }, [P], TH);
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it('snaps BOTH axes at once (corner-to-corner) → dx, dy and two guides', () => {
    const r = computeSnap({ x: 103, y: 103, w: 50, h: 50 }, [P], TH);
    expect(r.dx).toBe(-3);
    expect(r.dy).toBe(-3);
    expect(r.guides.filter((g) => g.orient === 'v').length).toBe(1);
    expect(r.guides.filter((g) => g.orient === 'h').length).toBe(1);
  });

  it('a single per-axis guide spans the union of EVERY peer sharing the snapped line', () => {
    const P2: SnapRect = { x: 100, y: 400, w: 80, h: 80 }; // also left = 100
    const moving: SnapRect = { x: 103, y: 250, w: 50, h: 50 };
    const r = computeSnap(moving, [P, P2], TH);
    const v = r.guides.find((g) => g.orient === 'v')!;
    expect(v.pos).toBe(100);
    // spans from the topmost aligned box (P at y=100) to the bottom of P2 (y=480),
    // unioned with the snapped moving rect (250..300).
    expect(v.start).toBe(100);
    expect(v.end).toBe(480);
  });

  it('no peers → no-op', () => {
    expect(computeSnap({ x: 0, y: 0, w: 10, h: 10 }, [], TH)).toEqual({ dx: 0, dy: 0, guides: [] });
  });
});

describe('computeResizeSnap (the snap primitive 2nd caller)', () => {
  const MIN = 20;
  it("snaps a RIGHT-edge ('e') resize so the right edge lands on a peer line; x/y/h untouched", () => {
    // right edge at 303 → snaps to peer right (200)? no, nearest within 6: make right near a peer left=100? too far.
    // Peer lines at 100/150/200. Put right edge at 197 → snaps to 200 (peer right). w grows by 3.
    const rect: SnapRect = { x: 50, y: 300, w: 147, h: 50 }; // right = 197
    const r = computeResizeSnap(rect, 'e', [P], TH, MIN, MIN);
    expect(r.rect.x).toBe(50); // left fixed
    expect(r.rect.y).toBe(300);
    expect(r.rect.h).toBe(50);
    expect(r.rect.w).toBe(150); // 147 + (200 − 197)
    expect(r.guides.some((g) => g.orient === 'v' && g.pos === 200)).toBe(true);
  });

  it("snaps a LEFT-edge ('w') resize by moving x and shrinking w (right edge fixed)", () => {
    // left edge at 103 → snaps to peer left 100; x −3, w +3 (right edge x+w stays).
    const rect: SnapRect = { x: 103, y: 300, w: 80, h: 50 }; // right = 183
    const r = computeResizeSnap(rect, 'w', [P], TH, MIN, MIN);
    expect(r.rect.x).toBe(100); // 103 − 3
    expect(r.rect.w).toBe(83); // 80 − (−3)
    expect(r.rect.x + r.rect.w).toBe(183); // right edge unchanged
    expect(r.guides.some((g) => g.orient === 'v' && g.pos === 100)).toBe(true);
  });

  it("snaps a BOTTOM-edge ('s') resize on the y axis with a horizontal guide", () => {
    const rect: SnapRect = { x: 300, y: 50, w: 50, h: 147 }; // bottom = 197
    const r = computeResizeSnap(rect, 's', [P], TH, MIN, MIN);
    expect(r.rect.h).toBe(150); // 147 + (200 − 197)
    expect(r.rect.y).toBe(50);
    expect(r.guides.some((g) => g.orient === 'h' && g.pos === 200)).toBe(true);
  });

  it("snaps a TOP-edge ('n') resize by moving y and shrinking h (bottom edge fixed)", () => {
    // top edge at 103 → snaps to peer top 100; y −3, h +3 (bottom edge y+h stays).
    const rect: SnapRect = { x: 300, y: 103, w: 50, h: 80 }; // bottom = 183
    const r = computeResizeSnap(rect, 'n', [P], TH, MIN, MIN);
    expect(r.rect.y).toBe(100); // 103 − 3
    expect(r.rect.h).toBe(83); // 80 − (−3)
    expect(r.rect.y + r.rect.h).toBe(183); // bottom edge unchanged
    expect(r.rect.x).toBe(300); // x/w untouched on a top resize
    expect(r.rect.w).toBe(50);
    expect(r.guides.some((g) => g.orient === 'h' && g.pos === 100)).toBe(true);
  });

  it("snaps a CORNER ('se') on BOTH axes → two guides", () => {
    const rect: SnapRect = { x: 50, y: 50, w: 147, h: 147 }; // right=197, bottom=197
    const r = computeResizeSnap(rect, 'se', [P], TH, MIN, MIN);
    expect(r.rect.w).toBe(150);
    expect(r.rect.h).toBe(150);
    expect(r.guides.filter((g) => g.orient === 'v').length).toBe(1);
    expect(r.guides.filter((g) => g.orient === 'h').length).toBe(1);
  });

  it('skips a snap that would shrink below the minimum size', () => {
    // right edge at 104 near peer left 100 → snap delta −4 would make w = 21 − 4 = 17 < MIN(20): skipped.
    const rect: SnapRect = { x: 83, y: 300, w: 21, h: 50 }; // right = 104
    const r = computeResizeSnap(rect, 'e', [P], TH, MIN, MIN);
    expect(r.rect.w).toBe(21); // unchanged
    expect(r.guides.length).toBe(0);
  });

  it('beyond threshold → rect unchanged, no guides', () => {
    const rect: SnapRect = { x: 300, y: 300, w: 50, h: 50 };
    const r = computeResizeSnap(rect, 'se', [P], TH, MIN, MIN);
    expect(r.rect).toEqual(rect);
    expect(r.guides).toEqual([]);
  });

  it('no peers → rect unchanged', () => {
    const rect: SnapRect = { x: 0, y: 0, w: 30, h: 30 };
    expect(computeResizeSnap(rect, 'se', [], TH, MIN, MIN)).toEqual({ rect, guides: [] });
  });
});

describe('snapRectToGrid (the fixed-lattice 3rd snap source)', () => {
  const G = 24;
  it('rounds a near top-left DOWN to the nearest grid cell', () => {
    // origin (100,100): 100/24 = 4.16 → round 4 → 96. correction = 96-100 = -4.
    expect(snapRectToGrid({ x: 100, y: 100, w: 50, h: 50 }, G)).toEqual({ dx: -4, dy: -4 });
  });
  it('rounds a near top-left UP to the nearest grid cell', () => {
    // origin (108,108): 108/24 = 4.5 → round 5 → 120. correction = +12. (.5 rounds up)
    expect(snapRectToGrid({ x: 108, y: 108, w: 10, h: 10 }, G)).toEqual({ dx: 12, dy: 12 });
  });
  it('is a no-op when the origin already sits exactly on the grid', () => {
    expect(snapRectToGrid({ x: 96, y: 48, w: 33, h: 33 }, G)).toEqual({ dx: 0, dy: 0 });
  });
  it('snaps the TOP-LEFT (size is irrelevant — a group keeps its layout under one shared delta)', () => {
    const a = snapRectToGrid({ x: 50, y: 50, w: 10, h: 10 }, G);
    const b = snapRectToGrid({ x: 50, y: 50, w: 999, h: 999 }, G);
    expect(a).toEqual(b); // correction depends only on origin, so every group member shifts equally
  });
  it('handles negative origins (boards pan into negative world space)', () => {
    // -100/24 = -4.16 → round -4 → -96. correction = -96 - (-100) = +4.
    expect(snapRectToGrid({ x: -100, y: -100, w: 20, h: 20 }, G)).toEqual({ dx: 4, dy: 4 });
  });
  it('grid <= 0 is a hard no-op (never divides by zero / snaps to nothing)', () => {
    expect(snapRectToGrid({ x: 37, y: 91, w: 5, h: 5 }, 0)).toEqual({ dx: 0, dy: 0 });
    expect(snapRectToGrid({ x: 37, y: 91, w: 5, h: 5 }, -8)).toEqual({ dx: 0, dy: 0 });
  });
  it('lands EXACTLY where the one-shot snapToGrid batch op would (shared grid semantics, L100)', () => {
    // batch snapToGrid rounds x,y to Math.round(v/grid)*grid; the drag correction must reach the same cell.
    const box = { x: 137, y: 205, w: 40, h: 40 };
    const { dx, dy } = snapRectToGrid(box, G);
    expect(box.x + dx).toBe(Math.round(box.x / G) * G);
    expect(box.y + dy).toBe(Math.round(box.y / G) * G);
  });
});

describe('snap-guides red-team — untrusted peer/grid coords never poison output (cont.98 batch-34)', () => {
  it('a peer sharing the snapped line with a NaN/MAX_VALUE perpendicular coord yields a finite guide span', () => {
    const moving: SnapRect = { x: 103, y: 300, w: 50, h: 50 };
    // Two hostile peers share the peer LEFT line x=100 (so they contribute to the vertical guide span),
    // but carry a NaN and a MAX_VALUE y — a raw Math.min/max would poison start/end.
    const peers: SnapRect[] = [
      { x: 100, y: Number.NaN, w: 0, h: 10 },
      { x: 100, y: Number.MAX_VALUE, w: 0, h: Number.MAX_VALUE },
    ];
    const { guides } = computeSnap(moving, peers, TH);
    const v = guides.find((g) => g.orient === 'v')!;
    expect(v).toBeDefined();
    expect(Number.isFinite(v.pos)).toBe(true);
    expect(Number.isFinite(v.start)).toBe(true);
    expect(Number.isFinite(v.end)).toBe(true);
  });

  it('a NaN or Infinity grid yields no correction (never NaN); a non-finite origin is clamped', () => {
    const box: SnapRect = { x: 137, y: 205, w: 40, h: 40 };
    expect(snapRectToGrid(box, Number.NaN)).toEqual({ dx: 0, dy: 0 });
    expect(snapRectToGrid(box, Number.POSITIVE_INFINITY)).toEqual({ dx: 0, dy: 0 });
    expect(snapRectToGrid(box, 0)).toEqual({ dx: 0, dy: 0 });
    const wild = snapRectToGrid({ x: Number.NaN, y: Number.MAX_VALUE, w: 40, h: 40 }, 25);
    expect(Number.isFinite(wild.dx)).toBe(true);
    expect(Number.isFinite(wild.dy)).toBe(true);
  });
});
