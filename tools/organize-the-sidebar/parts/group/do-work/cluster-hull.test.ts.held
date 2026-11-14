// packages/group/do-work/cluster-hull.test.ts
import { describe, it, expect } from 'vitest';
import { convexHull, hullPath, rectCorners, pointInHull, type HullRect } from './cluster-hull';

type Pt = { x: number; y: number };

const wellFormed = (d: string) =>
  d.length > 0 && d.startsWith('M') && d.trimEnd().endsWith('Z') && !/(NaN|Infinity|undefined)/.test(d);

describe('convexHull — Andrew monotone chain', () => {
  it('returns [] for no points, [p] for one, the pair for two', () => {
    expect(convexHull([])).toEqual([]);
    expect(convexHull([{ x: 3, y: 4 }])).toEqual([{ x: 3, y: 4 }]);
    const two = convexHull([{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    expect(two).toHaveLength(2);
  });

  it('collapses a fully COLLINEAR set to its two extremes (never a bogus triangle)', () => {
    const line: Pt[] = [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 2, y: 2 }, { x: 9, y: 9 }];
    const hull = convexHull(line);
    expect(hull).toHaveLength(2);
    // extremes are the min and max along the line
    const xs = hull.map((p) => p.x).sort((a, b) => a - b);
    expect(xs).toEqual([0, 9]);
  });

  it('drops interior + collinear-edge points, keeps only true corners of a square', () => {
    const pts: Pt[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, // corners
      { x: 5, y: 5 }, // interior
      { x: 5, y: 0 }, // on an edge (collinear) → dropped
    ];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(4);
    expect(hull).toEqual(expect.arrayContaining([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]));
    expect(hull).not.toContainEqual({ x: 5, y: 5 });
    expect(hull).not.toContainEqual({ x: 5, y: 0 });
  });

  it('is deterministic and order-independent (shuffled input → same hull set)', () => {
    const a = convexHull([{ x: 0, y: 0 }, { x: 4, y: 1 }, { x: 2, y: 5 }, { x: 6, y: 4 }]);
    const b = convexHull([{ x: 6, y: 4 }, { x: 2, y: 5 }, { x: 0, y: 0 }, { x: 4, y: 1 }]);
    expect(new Set(a.map((p) => `${p.x},${p.y}`))).toEqual(new Set(b.map((p) => `${p.x},${p.y}`)));
  });

  it('every input point is enclosed by (or on) the hull it produces', () => {
    const pts: Pt[] = [
      { x: 0, y: 0 }, { x: 30, y: 4 }, { x: 12, y: 25 }, { x: 20, y: 20 },
      { x: 8, y: 8 }, { x: 25, y: 10 }, { x: 4, y: 18 },
    ];
    const hull = convexHull(pts);
    for (const p of pts) {
      // strictly-interior points test true; corner points sit ON the hull (allow either)
      const onHull = hull.some((h) => h.x === p.x && h.y === p.y);
      expect(pointInHull(hull, p) || onHull).toBe(true);
    }
  });

  it('clamps non-finite / huge coordinates (never emits NaN)', () => {
    const hull = convexHull([
      { x: NaN, y: 0 }, { x: 10, y: Infinity }, { x: 1e30, y: 2 }, { x: 3, y: 3 },
    ]);
    for (const p of hull) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe('hullPath — degenerate-safe blob', () => {
  it('empty hull → empty string', () => {
    expect(hullPath([])).toBe('');
  });

  it('1 vertex → a circle path of radius=padding (well-formed, two arcs)', () => {
    const d = hullPath([{ x: 50, y: 50 }], 24);
    expect(wellFormed(d)).toBe(true);
    expect((d.match(/A /g) ?? []).length).toBe(2); // two semicircle arcs
  });

  it('2 vertices → a stadium (parallel sides + two caps)', () => {
    const d = hullPath([{ x: 0, y: 0 }, { x: 100, y: 0 }], 20);
    expect(wellFormed(d)).toBe(true);
    expect((d.match(/A /g) ?? []).length).toBe(2); // two semicircle caps
    expect((d.match(/L /g) ?? []).length).toBe(2); // two straight sides
  });

  it('≥3 vertices → a rounded, OUTWARD-padded polygon (each corner a quadratic)', () => {
    const square = convexHull(rectCorners({ x: 0, y: 0, w: 100, h: 100 }));
    const d = hullPath(square, 24, 18);
    expect(wellFormed(d)).toBe(true);
    expect((d.match(/Q /g) ?? []).length).toBe(4); // one fillet per corner
  });

  it('padding grows the region strictly OUTSIDE the raw item corners', () => {
    const corners = rectCorners({ x: 0, y: 0, w: 100, h: 100 });
    const hull = convexHull(corners);
    const d = hullPath(hull, 30, 0);
    // extract every coordinate; the padded blob must reach beyond the raw 0..100 box on both axes
    const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    expect(Math.min(...nums)).toBeLessThan(0); // pushed left/up past 0
    expect(Math.max(...nums)).toBeGreaterThan(100); // pushed right/down past 100
  });

  it('never emits NaN even from a degenerate zero-size cluster', () => {
    const d = hullPath(convexHull(rectCorners({ x: 5, y: 5, w: 0, h: 0 })), 12);
    expect(wellFormed(d)).toBe(true);
  });
});

describe('rectCorners', () => {
  it('returns the four corners CW from top-left', () => {
    const r: HullRect = { x: 10, y: 20, w: 30, h: 40 };
    expect(rectCorners(r)).toEqual([
      { x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 60 }, { x: 10, y: 60 },
    ]);
  });

  it('a cluster of several rects hulls to a blob that encloses every rect centre', () => {
    const rects: HullRect[] = [
      { x: 0, y: 0, w: 40, h: 30 },
      { x: 120, y: 10, w: 40, h: 30 },
      { x: 60, y: 100, w: 40, h: 30 },
    ];
    const hull = convexHull(rects.flatMap(rectCorners));
    for (const r of rects) {
      expect(pointInHull(hull, { x: r.x + r.w / 2, y: r.y + r.h / 2 })).toBe(true);
    }
  });
});
