// packages/group/do-work/median-cut-palette.test.ts
//
// Pure proof of the median-cut palette primitive. No canvas — operates on synthetic RGB pixel arrays. Covers
// recovering N clusters, population ordering (dominant colour first), the never-fabricate contract (fewer
// distinct colours than count → fewer results), the degenerate inputs, and pixelsFromImageData sampling.

import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { medianCutPalette, pixelsFromImageData, type RGB } from '../../../do-work/median-cut-palette.ts';

const rep = (px: RGB, n: number): RGB[] => Array.from({ length: n }, () => ({ ...px }));
// hex → RGB, for distance comparisons
const hexToRgb = (hex: string): RGB => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});
const dist = (a: RGB, b: RGB) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
/** true if `hexes` contains a colour within `tol` of `target`. */
const hasNear = (hexes: string[], target: RGB, tol = 40) => hexes.some((h) => dist(hexToRgb(h), target) <= tol);

describe('medianCutPalette', () => {
  it('recovers four distinct colour clusters', () => {
    const RED = { r: 220, g: 30, b: 30 };
    const GREEN = { r: 30, g: 200, b: 40 };
    const BLUE = { r: 40, g: 50, b: 210 };
    const YELLOW = { r: 230, g: 220, b: 40 };
    const pixels = [...rep(RED, 100), ...rep(GREEN, 100), ...rep(BLUE, 100), ...rep(YELLOW, 100)];
    const palette = medianCutPalette(pixels, 4);
    expect(palette).toHaveLength(4);
    for (const c of [RED, GREEN, BLUE, YELLOW]) expect(hasNear(palette, c)).toBe(true);
  });

  it('orders the palette by population — the most dominant colour first', () => {
    const RED = { r: 220, g: 30, b: 30 };
    const BLUE = { r: 40, g: 50, b: 210 };
    const pixels = [...rep(RED, 400), ...rep(BLUE, 100)]; // red 4x more common
    const palette = medianCutPalette(pixels, 2);
    expect(dist(hexToRgb(palette[0]), RED)).toBeLessThan(dist(hexToRgb(palette[0]), BLUE)); // palette[0] ≈ red
  });

  it('NEVER fabricates: a solid-colour image returns ONE colour even when 5 are asked', () => {
    const palette = medianCutPalette(rep({ r: 100, g: 140, b: 200 }, 500), 5);
    expect(palette).toHaveLength(1);
    expect(dist(hexToRgb(palette[0]), { r: 100, g: 140, b: 200 })).toBeLessThan(2);
  });

  it('is deterministic — same pixels + count → identical palette', () => {
    const px = [...rep({ r: 10, g: 20, b: 30 }, 50), ...rep({ r: 200, g: 210, b: 220 }, 50)];
    expect(medianCutPalette(px, 2)).toEqual(medianCutPalette(px, 2));
  });

  it('count <= 0 or no pixels → []', () => {
    expect(medianCutPalette([{ r: 1, g: 2, b: 3 }], 0)).toEqual([]);
    expect(medianCutPalette([], 4)).toEqual([]);
  });

  it('pixelsFromImageData samples RGB, skips transparent pixels, downsamples by step', () => {
    // 4 pixels RGBA: red(opaque), green(transparent), blue(opaque), white(opaque)
    const data = [220, 0, 0, 255, 0, 200, 0, 0, 0, 0, 210, 255, 255, 255, 255, 255];
    expect(pixelsFromImageData(data, 1)).toEqual([
      { r: 220, g: 0, b: 0 },
      { r: 0, g: 0, b: 210 },
      { r: 255, g: 255, b: 255 },
    ]); // the transparent green pixel is skipped
    // step 2 → every 2nd pixel: red (index 0), then blue (index 2). green(1) transparent anyway.
    expect(pixelsFromImageData(data, 2)).toEqual([{ r: 220, g: 0, b: 0 }, { r: 0, g: 0, b: 210 }]);
  });
});
