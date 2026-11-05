// packages/group/show/image-footprint.test.ts
//
// #215 — the aspect-preserving placement footprint. Composes the #214 draft
// footprint primitive: an image draft carries `w`/`h` from its natural size so a
// placed image matches its real proportions instead of the default 220×160 box.

import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { imageFootprint } from '../../../show/image-footprint.ts';

describe('imageFootprint', () => {
  it('caps the long edge at maxLong and preserves aspect ratio (landscape)', () => {
    const f = imageFootprint(4000, 3000, { maxLong: 480 });
    expect(f).toEqual({ w: 480, h: 360 }); // 4:3 preserved, long edge = 480
  });

  it('caps the long edge for a portrait too (height is the long edge)', () => {
    const f = imageFootprint(3000, 4000, { maxLong: 480 });
    expect(f).toEqual({ w: 360, h: 480 });
  });

  it('preserves a square', () => {
    expect(imageFootprint(1000, 1000, { maxLong: 480 })).toEqual({ w: 480, h: 480 });
  });

  it('never squishes a portrait into a landscape box (the bug this fixes)', () => {
    const f = imageFootprint(600, 1200, { maxLong: 480 })!;
    expect(f.h).toBeGreaterThan(f.w); // stays taller than wide
    expect(f.h / f.w).toBeCloseTo(2, 1); // ratio preserved
  });

  it('floors the SHORT edge so an extreme panorama stays grabbable', () => {
    const f = imageFootprint(4000, 200, { maxLong: 480, minShort: 80 })!;
    expect(f.h).toBe(80); // short edge floored up from ~24
    expect(f.w).toBeGreaterThan(480); // width grows to keep the ratio
  });

  it('scales the long edge TO maxLong regardless of up or down (canvas-legibility target)', () => {
    // a 300×200 image: long edge 300 < 480 → scale = 480/300 = 1.6 → 480×320.
    // (The board treats maxLong as the target long edge for on-canvas legibility.)
    expect(imageFootprint(300, 200, { maxLong: 480 })).toEqual({ w: 480, h: 320 });
  });

  it('returns null for a degenerate / non-positive size (caller falls back to default)', () => {
    expect(imageFootprint(0, 100)).toBeNull();
    expect(imageFootprint(100, 0)).toBeNull();
    expect(imageFootprint(-5, 10)).toBeNull();
    expect(imageFootprint(NaN, 10)).toBeNull();
    expect(imageFootprint(Infinity, 10)).toBeNull();
  });

  it('uses sane defaults (maxLong 480, minShort 80) when no options given', () => {
    expect(imageFootprint(1000, 500)).toEqual({ w: 480, h: 240 });
  });

  it('an EXTREME aspect whose short edge rounds to 0 stays FINITE (no divide-by-zero) (cont.98 batch-10)', () => {
    // 1×1_000_000 → the long edge scaled to 480 makes the short edge round to 0. The old short-edge floor
    // divided minShort by that rounded 0 → Infinity height. Now both edges scale by the same finite factor.
    const f = imageFootprint(1, 1_000_000)!;
    expect(f).not.toBeNull();
    expect(Number.isFinite(f.w)).toBe(true);
    expect(Number.isFinite(f.h)).toBe(true);
    expect(f.w).toBe(80); // the short edge is floored to minShort (grabbable)
    expect(f.h).toBeGreaterThan(0);
    // aspect preserved (1 : 1_000_000) — never a wrong-but-finite squish, never Infinity.
    expect(f.h / f.w).toBeCloseTo(1_000_000, -2);

    const tall = imageFootprint(1_000_000, 1)!; // the transpose stays finite too
    expect(Number.isFinite(tall.w)).toBe(true);
    expect(tall.h).toBe(80);
  });
});
