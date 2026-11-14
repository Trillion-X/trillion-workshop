// packages/group/do-work/density-field.test.ts
import { describe, it, expect } from 'vitest';
import {
  densityField,
  computeBounds,
  normalizedCells,
  hotspot,
  rampColor,
  type DensityRect,
  type DensityRamp,
} from './density-field';

const rect = (x: number, y: number, w = 40, h = 40): DensityRect => ({ x, y, w, h });

describe('computeBounds', () => {
  it('empty → unit box; else the tight AABB', () => {
    expect(computeBounds([])).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
    expect(computeBounds([rect(10, 20, 30, 40), rect(100, 0, 10, 10)])).toEqual({
      minX: 10, minY: 0, maxX: 110, maxY: 60,
    });
  });
});

describe('densityField — weight accumulation', () => {
  it('empty board → an empty field (max 0, total 0)', () => {
    const f = densityField([]);
    expect(f.max).toBe(0);
    expect(f.total).toBe(0);
    expect(normalizedCells(f).every((v) => v === 0)).toBe(true);
  });

  it('CONSERVES weight — total deposited ≈ Σ weightOf (a rect spread across cells sums to its weight)', () => {
    // rects that straddle cell boundaries at cellSize 60
    const rects = [rect(0, 0, 100, 100), rect(50, 50, 120, 30), rect(200, 10, 20, 20)];
    const f = densityField(rects, { cellSize: 60 });
    expect(f.total).toBeCloseTo(3, 6); // three rects × weight 1
  });

  it('weighted by an injected weightOf conserves the weighted sum', () => {
    const rects = [rect(0, 0), rect(300, 300)];
    const f = densityField(rects, { cellSize: 60, weightOf: (_r, i) => (i === 0 ? 5 : 2) });
    expect(f.total).toBeCloseTo(7, 6);
  });

  it('a denser pile reads hotter than a lone note (normalised)', () => {
    // four overlapping notes in one spot vs one note far away
    const rects = [rect(0, 0), rect(5, 5), rect(10, 0), rect(0, 10), rect(400, 400)];
    const f = densityField(rects, { cellSize: 60 });
    const hs = hotspot(f)!;
    expect(hs.value).toBe(1); // the pile is the max
    // the pile centre is near (0..50), not near the lone note at 400
    expect(hs.center.x).toBeLessThan(120);
    expect(hs.center.y).toBeLessThan(120);
  });

  it('a zero-area footprint drops its full weight in one cell (still conserved)', () => {
    const f = densityField([{ x: 30, y: 30, w: 0, h: 0 }], { cellSize: 60, weightOf: () => 3 });
    expect(f.total).toBeCloseTo(3, 6);
    expect(f.max).toBeCloseTo(3, 6);
  });

  it('clamps NaN / negative weights to 0 (never a NaN cell)', () => {
    const f = densityField([rect(0, 0), rect(80, 0), rect(160, 0)], {
      cellSize: 60,
      weightOf: (_r, i) => [NaN, -5, 4][i],
    });
    expect(Number.isFinite(f.total)).toBe(true);
    expect(f.total).toBeCloseTo(4, 6); // only the third (4) counts
  });

  it('a huge-span board stays BOUNDED (grid auto-coarsens under the cell cap, no OOM)', () => {
    const f = densityField([rect(0, 0), rect(5_000_000, 5_000_000)], { cellSize: 1 });
    expect(f.cols * f.rows).toBeLessThanOrEqual(250_000);
    expect(f.cellSize).toBeGreaterThan(1); // auto-grew
    expect(f.total).toBeCloseTo(2, 6);
  });

  it('is deterministic (same input → identical field)', () => {
    const rects = [rect(0, 0), rect(30, 40), rect(90, 10)];
    expect(densityField(rects).cells).toEqual(densityField(rects).cells);
  });
});

describe('hotspot', () => {
  it('null for an empty field; the argmax cell otherwise', () => {
    expect(hotspot(densityField([]))).toBeNull();
    const f = densityField([rect(0, 0), rect(2, 2), rect(500, 500)], { cellSize: 60 });
    const hs = hotspot(f)!;
    expect(hs.value).toBe(1);
    expect(hs.center.x).toBeLessThan(120);
  });
});

describe('rampColor — DATA ramp interpolation', () => {
  const ramp: DensityRamp = [
    { at: 0, color: [0, 0, 255] },
    { at: 0.5, color: [0, 255, 0] },
    { at: 1, color: [255, 0, 0] },
  ];
  it('clamps below/above the ramp to its ends', () => {
    expect(rampColor(-1, ramp)).toBe('rgb(0,0,255)');
    expect(rampColor(2, ramp)).toBe('rgb(255,0,0)');
  });
  it('interpolates between stops', () => {
    expect(rampColor(0.25, ramp)).toBe('rgb(0,128,128)'); // halfway blue→green
    expect(rampColor(0.5, ramp)).toBe('rgb(0,255,0)');
  });
  it('non-finite t → the low end (never NaN)', () => {
    expect(rampColor(NaN, ramp)).toBe('rgb(0,0,255)');
  });
});
