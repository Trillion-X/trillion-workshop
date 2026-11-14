// packages/group/do-work/shape-geometry.test.ts
//
// #213 (primitive P5 — Parametric Shape Descriptor). Proves the geometry leaf is
// the SSOT: (1) it reproduces the #155 catalog clip-paths byte-for-byte (zero live
// regression), (2) the anti-dome invariant — ellipse/rect fill the WHOLE box, so a
// circle can never render as a dome, (3) live-clip == derived, and (4) the deletion
// test — a formula N-gon / N-star the catalog never listed renders + exports with
// ZERO new code (true generative primitive, not an enumerated set).

import { describe, expect, it } from 'vitest';
import {
  shapeClipPathOf,
  shapeSvgPathOf,
  shapeExtentOf,
  shapePolygonPoints,
  shapeOutlinePoints,
  type ShapeGeometry,
} from './shape-geometry';
import { BOARD_SHAPES, shapeClipPathById, shapeSvgPathById } from '../show/board-shapes';

describe('#213 shape-geometry — clip-path reproduction (no live regression)', () => {
  it('reproduces the exact #155 catalog clip-path strings', () => {
    expect(shapeClipPathOf({ kind: 'rect' })).toBe('');
    expect(shapeClipPathOf({ kind: 'ellipse' })).toBe('ellipse(50% 50% at 50% 50%)');
    expect(shapeClipPathOf({ kind: 'polygon', points: [[50, 0], [100, 50], [50, 100], [0, 50]] }))
      .toBe('polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)');
    expect(shapeClipPathOf({ kind: 'polygon', points: [[50, 0], [61, 35], [98, 35], [68, 57], [79, 91], [50, 70], [21, 91], [32, 57], [2, 35], [39, 35]] }))
      .toBe('polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)');
  });

  it('every catalog row derives its clip-path from geometry, unchanged from #155', () => {
    const expected: Record<string, string> = {
      rectangle: '',
      ellipse: 'ellipse(50% 50% at 50% 50%)',
      diamond: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
      triangle: 'polygon(50% 0%, 100% 100%, 0% 100%)',
      hexagon: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
      star: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)',
      callout: 'polygon(0% 0%, 100% 0%, 100% 75%, 30% 75%, 15% 100%, 15% 75%, 0% 75%)',
    };
    for (const s of BOARD_SHAPES) {
      expect(s.clipPath).toBe(expected[s.id]);
      expect(shapeClipPathById(s.id)).toBe(expected[s.id]);
    }
  });
});

describe('#213 shape-geometry — the anti-dome invariant (the actual bug)', () => {
  it('ellipse and rect fill the FULL box (extent 0..100 on both axes) — never a dome', () => {
    expect(shapeExtentOf({ kind: 'ellipse' })).toEqual([0, 0, 100, 100]);
    expect(shapeExtentOf({ kind: 'rect' })).toEqual([0, 0, 100, 100]);
  });

  it('the ellipse SVG path spans the full box width (0 and 100), not a half-height dome', () => {
    const d = shapeSvgPathOf({ kind: 'ellipse' });
    expect(d).toContain('0,50');   // left extreme
    expect(d).toContain('100,50'); // right extreme
    expect(d).toContain('50,50');  // the ellipse is centred (radius 50/50) → full box
  });

  it('a polygon shape spans its designed extent (star reaches the box top at y=0)', () => {
    const star = BOARD_SHAPES.find((s) => s.id === 'star')!;
    const [, minY] = shapeExtentOf(star.geometry);
    expect(minY).toBe(0); // top point touches the box top — not clipped away
  });
});

describe('#213 shape-geometry — live == export (one path, both sides)', () => {
  it('shapeSvgPathById gives a real path for shaped ids and empty for rectangle/unknown', () => {
    expect(shapeSvgPathById('rectangle')).toBe('');
    expect(shapeSvgPathById(undefined)).toBe('');
    expect(shapeSvgPathById('not-a-shape')).toBe('');
    expect(shapeSvgPathById('ellipse')).toContain('A 50,50'); // ellipse arc
    expect(shapeSvgPathById('diamond')).toBe('M 50,0 L 100,50 L 50,100 L 0,50 Z');
  });
});

describe('#213 shape-geometry — DELETION TEST (generative primitive, not an enum)', () => {
  it('a formula N-gon the catalog never listed renders with ZERO new code', () => {
    const pentagon: ShapeGeometry = { kind: 'ngon', sides: 5 };
    const pts = shapePolygonPoints(pentagon)!;
    expect(pts).toHaveLength(5);
    // fills the box: some vertex at the top (y≈0), extent within [0,100].
    const [minX, minY, maxX, maxY] = shapeExtentOf(pentagon);
    expect(minY).toBeCloseTo(0, 5);   // first vertex sits at the top (rotation 0)
    expect(minX).toBeGreaterThanOrEqual(0);
    expect(maxX).toBeLessThanOrEqual(100);
    expect(maxY).toBeLessThanOrEqual(100);
    expect(shapeSvgPathOf(pentagon)).toMatch(/^M .* Z$/);
    // clip-path also falls out for free.
    expect(shapeClipPathOf(pentagon)).toMatch(/^polygon\(/);
  });

  it('a formula N-point star the catalog never listed has 2N vertices, ZERO new code', () => {
    const sixStar: ShapeGeometry = { kind: 'star', points: 6, innerRatio: 0.4 };
    expect(shapePolygonPoints(sixStar)).toHaveLength(12);
    expect(shapeSvgPathOf(sixStar)).toMatch(/^M .* Z$/);
  });

  it('an octagon (ngon sides:8) is one descriptor — the primitive is unbounded', () => {
    expect(shapePolygonPoints({ kind: 'ngon', sides: 8 })).toHaveLength(8);
  });

  describe('shapeOutlinePoints (cont.26 rough-shape ring)', () => {
    it('a diamond → its 4 vertices scaled into the w×h box, CLOSED (ring returns to start)', () => {
      const pts = shapeOutlinePoints({ kind: 'polygon', points: [[50, 0], [100, 50], [50, 100], [0, 50]] }, 200, 100, 0);
      expect(pts).toHaveLength(5); // 4 vertices + the closing point
      expect(pts[0]).toEqual(pts[4]); // closed loop
      // percent (50,0)/(100,50) scaled to a 200×100 box (pad 0): top vertex at x=100, right at x=200.
      expect(pts[0]).toEqual({ x: 100, y: 0 });
      expect(pts[1]).toEqual({ x: 200, y: 50 });
    });
    it('an ellipse is sampled into `segments` points (+1 closing), all inside the box', () => {
      const pts = shapeOutlinePoints({ kind: 'ellipse' }, 120, 80, 0, 24);
      expect(pts).toHaveLength(25);
      for (const p of pts) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(120);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(80);
      }
    });
    it('a rect falls back to the four corners (closed) — every kind yields a ring', () => {
      const pts = shapeOutlinePoints({ kind: 'rect' }, 100, 100, 0);
      expect(pts).toHaveLength(5);
      expect(pts[0]).toEqual(pts[4]);
    });
  });

  describe('shape-geometry red-team — untrusted descriptor never OOMs, crashes, or emits non-finite (cont.98 batch-36)', () => {
    it('a huge ngon `sides` / star `points` is capped (no Array.from({length:1e9}) OOM)', () => {
      expect(shapePolygonPoints({ kind: 'ngon', sides: 1e9 })!.length).toBeLessThanOrEqual(512);
      expect(shapePolygonPoints({ kind: 'ngon', sides: Number.MAX_VALUE })!.length).toBeLessThanOrEqual(512);
      // star emits n*2 verts; n capped at 512 -> <= 1024
      expect(shapePolygonPoints({ kind: 'star', points: 1e9, innerRatio: 0.5 })!.length).toBeLessThanOrEqual(1024);
      // a NaN count falls to the valid floor, never a crash
      expect(shapePolygonPoints({ kind: 'ngon', sides: Number.NaN })!.length).toBeGreaterThanOrEqual(3);
    });

    it('a million-point polygon does not RangeError in shapeExtentOf (capped, Math.min safe)', () => {
      const points = Array.from({ length: 200_000 }, (_, i) => [i % 100, (i * 7) % 100] as [number, number]);
      const ext = shapeExtentOf({ kind: 'polygon', points });
      expect(ext.every(Number.isFinite)).toBe(true);
    });

    it('a NaN/MAX_VALUE polygon point never reaches the clip-path / svg path / extent as non-finite', () => {
      const geo = { kind: 'polygon', points: [[Number.NaN, 0], [Number.MAX_VALUE, 100], [50, Number.POSITIVE_INFINITY]] } as const;
      expect(/NaN|Infinity/.test(shapeClipPathOf(geo))).toBe(false);
      expect(/NaN|Infinity/.test(shapeSvgPathOf(geo))).toBe(false);
      expect(shapeExtentOf(geo).every(Number.isFinite)).toBe(true);
    });

    it('a non-finite outline box yields finite ring points', () => {
      const pts = shapeOutlinePoints({ kind: 'ellipse' }, Number.NaN, Number.MAX_VALUE, 2, 32);
      expect(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    });
  });
});
