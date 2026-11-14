// packages/group/do-work/treemap.test.ts
import { describe, it, expect } from 'vitest';
import { squarifiedTreemap, type TreemapBounds } from './treemap';

const B: TreemapBounds = { x: 0, y: 0, w: 600, h: 400 };
const areaOf = (t: { w: number; h: number }) => t.w * t.h;

describe('squarifiedTreemap', () => {
  it('empty / all-zero / zero-bounds → []', () => {
    expect(squarifiedTreemap([], B)).toEqual([]);
    expect(squarifiedTreemap([0, 0, 0], B)).toEqual([]);
    expect(squarifiedTreemap([1, 2, 3], { x: 0, y: 0, w: 0, h: 100 })).toEqual([]);
  });

  it('CONSERVES area — Σ tile area ≈ bounds area', () => {
    const tiles = squarifiedTreemap([5, 3, 2, 1, 1, 8], B);
    const sum = tiles.reduce((s, t) => s + areaOf(t), 0);
    expect(sum).toBeCloseTo(B.w * B.h, 3);
  });

  it('tile AREA is proportional to value (2x value → ~2x area)', () => {
    const tiles = squarifiedTreemap([10, 5, 5], B);
    const byIndex = new Map(tiles.map((t) => [t.index, t]));
    expect(areaOf(byIndex.get(0)!)).toBeCloseTo(2 * areaOf(byIndex.get(1)!), 2);
    expect(areaOf(byIndex.get(1)!)).toBeCloseTo(areaOf(byIndex.get(2)!), 2);
  });

  it('drops non-positive / non-finite values (keeps the rest, area still conserved)', () => {
    const tiles = squarifiedTreemap([4, 0, -3, NaN, 4], B);
    expect(tiles.map((t) => t.index).sort()).toEqual([0, 4]); // only the two positives
    const sum = tiles.reduce((s, t) => s + areaOf(t), 0);
    expect(sum).toBeCloseTo(B.w * B.h, 3);
  });

  it('the largest value gets the largest tile', () => {
    const tiles = squarifiedTreemap([1, 9, 3, 2], B);
    const largest = tiles.reduce((m, t) => (areaOf(t) > areaOf(m) ? t : m));
    expect(largest.index).toBe(1); // value 9
  });

  it('every tile stays inside the bounds', () => {
    const tiles = squarifiedTreemap([7, 3, 5, 2, 6, 1, 4], B);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(B.x - 1e-6);
      expect(t.y).toBeGreaterThanOrEqual(B.y - 1e-6);
      expect(t.x + t.w).toBeLessThanOrEqual(B.x + B.w + 1e-6);
      expect(t.y + t.h).toBeLessThanOrEqual(B.y + B.h + 1e-6);
    }
  });

  it('tiles do not overlap (pairwise, on a small set)', () => {
    const tiles = squarifiedTreemap([5, 4, 3, 2], B);
    const overlap = (a: typeof tiles[0], b: typeof tiles[0]) => {
      const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      return ox * oy;
    };
    for (let i = 0; i < tiles.length; i++)
      for (let j = i + 1; j < tiles.length; j++) expect(overlap(tiles[i], tiles[j])).toBeCloseTo(0, 2);
  });

  it('a single value fills the whole bounds', () => {
    const tiles = squarifiedTreemap([42], B);
    expect(tiles).toHaveLength(1);
    expect(areaOf(tiles[0])).toBeCloseTo(B.w * B.h, 3);
  });

  it('is deterministic', () => {
    const v = [5, 3, 8, 1, 4, 2];
    expect(squarifiedTreemap(v, B)).toEqual(squarifiedTreemap(v, B));
  });

  it('produces reasonably square tiles (squarified, not slivers) — max aspect ratio bounded', () => {
    // many equal values → the algorithm should keep tiles near-square, not thin strips
    const tiles = squarifiedTreemap(Array.from({ length: 12 }, () => 1), { x: 0, y: 0, w: 400, h: 400 });
    const worstAspect = Math.max(...tiles.map((t) => Math.max(t.w / t.h, t.h / t.w)));
    expect(worstAspect).toBeLessThan(3); // slice-and-dice would be ~12; squarified stays low
  });
});
