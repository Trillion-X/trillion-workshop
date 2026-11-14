import { describe, expect, it } from 'vitest';
import { FULL_CROP, MIN_CROP, isCrop, isFullCrop, clampCrop, resizeCrop } from './crop-rect';

describe('crop-rect', () => {
  it('FULL_CROP is the whole image and reads as full', () => {
    expect(FULL_CROP).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(isFullCrop(FULL_CROP)).toBe(true);
    expect(isFullCrop({ x: 0.1, y: 0, w: 0.9, h: 1 })).toBe(false);
  });

  it('isCrop validates 4 finite numbers with positive size', () => {
    expect(isCrop({ x: 0, y: 0, w: 0.5, h: 0.5 })).toBe(true);
    expect(isCrop({ x: 0, y: 0, w: 0, h: 0.5 })).toBe(false); // zero width
    expect(isCrop({ x: 0, y: 0, w: 0.5 })).toBe(false); // missing h
    expect(isCrop(null)).toBe(false);
    expect(isCrop({ x: NaN, y: 0, w: 1, h: 1 })).toBe(false);
  });

  it('rejects an OUT-OF-UNIT crop — would offscreen/enlarge the export image (cont.98 batch-9)', () => {
    expect(isCrop({ x: 2, y: 0, w: 0.5, h: 0.5 })).toBe(false); // x far outside the unit square
    expect(isCrop({ x: 0, y: 0, w: 5, h: 0.5 })).toBe(false); // w exceeds the unit square
    expect(isCrop({ x: 0.8, y: 0, w: 0.5, h: 0.5 })).toBe(false); // x+w = 1.3 > 1
    expect(isCrop({ x: -0.5, y: 0, w: 0.5, h: 0.5 })).toBe(false); // negative x
    expect(isCrop({ x: 0, y: 0, w: 1, h: 1 })).toBe(true); // a full 0..1 crop is still valid (x+w === 1)
  });

  it('clampCrop keeps the window inside the unit square', () => {
    // overflow right/bottom → origin pulled in so x+w ≤ 1
    expect(clampCrop({ x: 0.8, y: 0.9, w: 0.5, h: 0.4 })).toEqual({ x: 0.5, y: 0.6, w: 0.5, h: 0.4 });
    // negative origin → pinned to 0
    expect(clampCrop({ x: -0.3, y: -0.1, w: 0.5, h: 0.5 })).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
  });

  it('clampCrop enforces the minimum size and never inverts', () => {
    const c = clampCrop({ x: 0.5, y: 0.5, w: 0.001, h: -0.2 });
    expect(c.w).toBe(MIN_CROP);
    expect(c.h).toBe(MIN_CROP);
    expect(c.w).toBeGreaterThan(0);
    expect(c.h).toBeGreaterThan(0);
    expect(c.x + c.w).toBeLessThanOrEqual(1);
    expect(c.y + c.h).toBeLessThanOrEqual(1);
  });

  it('clampCrop caps an oversized window at the full image', () => {
    expect(clampCrop({ x: 0, y: 0, w: 2, h: 3 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('resizeCrop drags the SE corner inward (shrinks w/h), staying in bounds', () => {
    // full crop, drag SE corner up-left by 0.3 of the source on each axis
    const out = resizeCrop(FULL_CROP, 'se', -0.3, -0.3);
    expect(out.x).toBe(0); // SE corner moves; NW origin pinned
    expect(out.y).toBe(0);
    expect(out.w).toBeCloseTo(0.7, 5);
    expect(out.h).toBeCloseTo(0.7, 5);
  });

  it('resizeCrop drags the NW corner inward (moves origin, shrinks), staying in bounds', () => {
    const out = resizeCrop(FULL_CROP, 'nw', 0.2, 0.25);
    expect(out.x).toBeCloseTo(0.2, 5);
    expect(out.y).toBeCloseTo(0.25, 5);
    expect(out.w).toBeCloseTo(0.8, 5);
    expect(out.h).toBeCloseTo(0.75, 5);
  });

  it('resizeCrop clamps a drag that would leave the image', () => {
    // from a half crop at the right edge, push the E edge further right (past 1)
    const half: { x: number; y: number; w: number; h: number } = { x: 0.5, y: 0.25, w: 0.5, h: 0.5 };
    const out = resizeCrop(half, 'e', 0.4, 0);
    expect(out.x + out.w).toBeLessThanOrEqual(1); // never exceeds the image
    expect(out.w).toBeLessThanOrEqual(0.5); // can't grow past the right edge
  });

  it('resizeCrop on a side edge leaves the other axis untouched', () => {
    const out = resizeCrop(FULL_CROP, 'e', -0.3, 0);
    expect(out.y).toBe(0);
    expect(out.h).toBe(1); // vertical extent unchanged by an east-edge drag
    expect(out.w).toBeCloseTo(0.7, 5);
  });

  it('resizeCrop W edge: moves the left edge in, pins the right, leaves Y untouched', () => {
    const out = resizeCrop(FULL_CROP, 'w', 0.3, 0);
    expect(out.x).toBeCloseTo(0.3, 5); // left edge moves right
    expect(out.w).toBeCloseTo(0.7, 5); // right edge (x+w=1) pinned
    expect(out.y).toBe(0);
    expect(out.h).toBe(1);
  });

  it('resizeCrop N edge: moves the top edge down, pins the bottom, leaves X untouched', () => {
    const out = resizeCrop(FULL_CROP, 'n', 0, 0.25);
    expect(out.y).toBeCloseTo(0.25, 5); // top edge moves down
    expect(out.h).toBeCloseTo(0.75, 5); // bottom edge (y+h=1) pinned
    expect(out.x).toBe(0);
    expect(out.w).toBe(1);
  });

  it('resizeCrop S edge: moves the bottom edge up, pins the top, leaves X untouched', () => {
    const out = resizeCrop(FULL_CROP, 's', 0, -0.25);
    expect(out.y).toBe(0); // top pinned
    expect(out.h).toBeCloseTo(0.75, 5); // bottom edge moves up
    expect(out.x).toBe(0);
    expect(out.w).toBe(1);
  });
});
