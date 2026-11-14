// packages/group/do-work/group-resize.test.ts
import { describe, expect, it } from 'vitest';
import {
  selectionBounds,
  anchorForHandle,
  scaleForHandleDrag,
  scaleRectsAroundAnchor,
  isCornerHandle,
  constrainToAxis,
  RESIZE_HANDLES,
  type Rect,
} from './group-resize';

describe('constrainToAxis — Shift-drag axis lock (#179)', () => {
  it('keeps the horizontal component and zeroes vertical when |dx| > |dy|', () => {
    expect(constrainToAxis(40, 7)).toEqual({ dx: 40, dy: 0 });
    expect(constrainToAxis(-40, 7)).toEqual({ dx: -40, dy: 0 });
  });

  it('keeps the vertical component and zeroes horizontal when |dy| > |dx|', () => {
    expect(constrainToAxis(7, 40)).toEqual({ dx: 0, dy: 40 });
    expect(constrainToAxis(7, -40)).toEqual({ dx: 0, dy: -40 });
  });

  it('breaks a tie toward horizontal (|dx| === |dy|)', () => {
    expect(constrainToAxis(30, 30)).toEqual({ dx: 30, dy: 0 });
    expect(constrainToAxis(30, -30)).toEqual({ dx: 30, dy: 0 });
  });

  it('is a no-op at the origin (zero delta stays zero)', () => {
    expect(constrainToAxis(0, 0)).toEqual({ dx: 0, dy: 0 });
  });
});

describe('selectionBounds', () => {
  it('returns the union rect of all boxes', () => {
    const b = selectionBounds([
      { x: 10, y: 20, w: 100, h: 50 },
      { x: 200, y: 0, w: 40, h: 200 },
    ])!;
    expect(b).toEqual({ x: 10, y: 0, w: 230, h: 200 }); // right=240,bottom=200
  });
  it('is null for an empty set', () => {
    expect(selectionBounds([])).toBeNull();
  });
});

describe('isCornerHandle / RESIZE_HANDLES', () => {
  it('has 8 handles, 4 corners', () => {
    expect(RESIZE_HANDLES).toHaveLength(8);
    expect(RESIZE_HANDLES.filter(isCornerHandle)).toEqual(['nw', 'ne', 'se', 'sw']);
  });
});

describe('anchorForHandle — the fixed opposite corner/edge', () => {
  const bounds: Rect = { x: 100, y: 100, w: 200, h: 100 }; // right=300, bottom=200
  it('se anchors at the top-left (nw)', () => {
    expect(anchorForHandle(bounds, 'se')).toEqual({ x: 100, y: 100 });
  });
  it('nw anchors at the bottom-right (se)', () => {
    expect(anchorForHandle(bounds, 'nw')).toEqual({ x: 300, y: 200 });
  });
  it('e anchors on the left edge', () => {
    expect(anchorForHandle(bounds, 'e').x).toBe(100);
  });
});

describe('scaleForHandleDrag', () => {
  const bounds: Rect = { x: 0, y: 0, w: 200, h: 100 };
  it('dragging SE +200x +100y doubles both axes', () => {
    const { sx, sy } = scaleForHandleDrag(bounds, 'se', 200, 100);
    expect([sx, sy]).toEqual([2, 2]);
  });
  it('an edge handle scales only its axis', () => {
    expect(scaleForHandleDrag(bounds, 'e', 200, 999)).toEqual({ sx: 2, sy: 1 });
    expect(scaleForHandleDrag(bounds, 's', 999, 50)).toEqual({ sx: 1, sy: 1.5 });
  });
  it('dragging a left/top handle inward shrinks (NW +100,+50 → 0.5,0.5)', () => {
    expect(scaleForHandleDrag(bounds, 'nw', 100, 50)).toEqual({ sx: 0.5, sy: 0.5 });
  });
  it('clamps to a positive floor (no inversion past the anchor)', () => {
    const { sx } = scaleForHandleDrag(bounds, 'e', -10000, 0);
    expect(sx).toBeGreaterThan(0);
  });
  it('uniform (shift) on a corner uses the dominant axis for both', () => {
    // +200x → sx=2, +20y → sy=1.2; dominant is sx → both become 2
    expect(scaleForHandleDrag(bounds, 'se', 200, 20, true)).toEqual({ sx: 2, sy: 2 });
  });
});

describe('scaleRectsAroundAnchor — set grows/shrinks as one unit', () => {
  it('doubling around the top-left anchor preserves relative layout', () => {
    const rects = [
      { id: 'a', x: 0, y: 0, w: 50, h: 50 },
      { id: 'b', x: 100, y: 0, w: 50, h: 50 },
    ];
    const out = scaleRectsAroundAnchor(rects, { x: 0, y: 0 }, 2, 2, 10, 10);
    expect(out[0]).toEqual({ id: 'a', x: 0, y: 0, w: 100, h: 100 });
    expect(out[1]).toEqual({ id: 'b', x: 200, y: 0, w: 100, h: 100 }); // position scales too
  });
  it('clamps each item to the min size', () => {
    const out = scaleRectsAroundAnchor([{ id: 'a', x: 0, y: 0, w: 50, h: 50 }], { x: 0, y: 0 }, 0.1, 0.1, 20, 20);
    expect([out[0].w, out[0].h]).toEqual([20, 20]);
  });
});

describe('group-resize red-team — untrusted geometry never produces a non-finite persisted rect (cont.98 batch-36)', () => {
  it('a NaN / Infinity drag yields a finite (no-op) scale, never NaN', () => {
    const b = { x: 0, y: 0, w: 100, h: 100 };
    const nan = scaleForHandleDrag(b, 'se', Number.NaN, Number.NaN);
    expect(Number.isFinite(nan.sx) && Number.isFinite(nan.sy)).toBe(true);
    const inf = scaleForHandleDrag(b, 'se', Number.POSITIVE_INFINITY, 50);
    expect(Number.isFinite(inf.sx) && Number.isFinite(inf.sy)).toBe(true);
  });

  it('a NaN/MAX_VALUE scale or item coord yields a finite persisted rect (Math.max(minW,NaN) trap closed)', () => {
    const rects = [{ id: 'a', x: 0, y: 0, w: 50, h: 50 }, { id: 'b', x: Number.MAX_VALUE, y: 0, w: 50, h: 50 }];
    for (const s of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) {
      const out = scaleRectsAroundAnchor(rects, { x: 0, y: 0 }, s, s, 20, 20);
      for (const r of out) {
        expect([r.x, r.y, r.w, r.h].every(Number.isFinite)).toBe(true);
        expect(r.w).toBeGreaterThanOrEqual(20);
        expect(r.h).toBeGreaterThanOrEqual(20);
      }
    }
  });
});
