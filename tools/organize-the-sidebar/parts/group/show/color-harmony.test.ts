import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { rgbToHsl, hslToRgb, toHex, harmonize, schemeById, BOARD_HARMONY_SCHEMES } from '../../../show/color-harmony.ts';
import { hueOf } from '../../../show/item-fill.ts';

/** Circular hue distance 0..180. */
const hueDist = (a: number, b: number) => { const r = Math.abs(a - b) % 360; return r > 180 ? 360 - r : r; };

describe('color-harmony (cont.24 — one HSL-rotation engine, injected scheme, DATA catalog)', () => {
  describe('rgb↔hsl round-trip + toHex', () => {
    it('converts the primaries correctly (red h0 / green h120 / blue h240, full sat)', () => {
      expect(rgbToHsl([255, 0, 0])).toEqual([0, 1, 0.5]);
      expect(rgbToHsl([0, 255, 0])[0]).toBeCloseTo(120, 4);
      expect(rgbToHsl([0, 0, 255])[0]).toBeCloseTo(240, 4);
    });
    it('is achromatic for greys (sat 0, hue 0)', () => {
      const [h, s] = rgbToHsl([128, 128, 128]);
      expect(s).toBe(0);
      expect(h).toBe(0);
    });
    it('round-trips a spread of colours within ±1 per channel', () => {
      for (const hex of ['#3366cc', '#fde68a', '#1f2937', '#a855f7', '#22c55e']) {
        const rgb = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] as [number, number, number];
        const back = hslToRgb(rgbToHsl(rgb));
        for (let i = 0; i < 3; i += 1) expect(Math.abs(back[i] - rgb[i])).toBeLessThanOrEqual(1);
      }
    });
    it('toHex clamps + zero-pads', () => {
      expect(toHex([255, 0, 8])).toBe('#ff0008');
      expect(toHex([300, -5, 128])).toBe('#ff0080');
    });
  });

  describe('catalog', () => {
    it('every scheme has a unique id, label, and ≥2 stops', () => {
      const ids = BOARD_HARMONY_SCHEMES.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const s of BOARD_HARMONY_SCHEMES) {
        expect(s.label.length).toBeGreaterThan(0);
        expect(s.stops.length).toBeGreaterThanOrEqual(2);
      }
    });
    it('schemeById resolves known / unknown / undefined', () => {
      expect(schemeById('triadic').id).toBe('triadic');
      expect(schemeById('nope')).toBe(BOARD_HARMONY_SCHEMES[0]);
      expect(schemeById(undefined)).toBe(BOARD_HARMONY_SCHEMES[0]);
    });
  });

  describe('harmonize', () => {
    const seed = '#2563eb'; // a vivid blue (hue ~217)
    it('complementary rotates the second colour ~180° from the seed', () => {
      const [a, b] = harmonize(seed, schemeById('complementary'));
      const ha = hueOf(a)!;
      const hb = hueOf(b)!;
      expect(hueDist(ha, hb)).toBeCloseTo(180, 0);
    });
    it('triadic spaces three colours ~120° apart', () => {
      const [a, b, c] = harmonize(seed, schemeById('triadic'));
      const [ha, hb, hc] = [hueOf(a)!, hueOf(b)!, hueOf(c)!];
      expect(hueDist(ha, hb)).toBeCloseTo(120, 0);
      expect(hueDist(hb, hc)).toBeCloseTo(120, 0);
    });
    it('analogous keeps the colours within ~30° of the seed', () => {
      const out = harmonize(seed, schemeById('analogous'));
      const hues = out.map((c) => hueOf(c)!);
      const base = hues[1]; // the middle stop is the seed itself (rotate 0)
      for (const h of hues) expect(hueDist(h, base)).toBeLessThanOrEqual(31);
    });
    it('monochromatic keeps ONE hue but varies lightness (a light→dark ramp of the same colour)', () => {
      const out = harmonize(seed, schemeById('monochromatic'));
      const hues = out.map((c) => hueOf(c)).filter((h): h is number => h !== null);
      // all (chromatic) stops share the seed hue
      for (const h of hues) expect(hueDist(h, hues[0])).toBeLessThanOrEqual(2);
      // lightness strictly increases across the ramp (dark → light)
      const lums = out.map((c) => rgbToHsl([parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)])[2]);
      for (let i = 1; i < lums.length; i += 1) expect(lums[i]).toBeGreaterThan(lums[i - 1]);
    });
    it('emits one hex per scheme stop, all valid #rrggbb', () => {
      for (const scheme of BOARD_HARMONY_SCHEMES) {
        const out = harmonize(seed, scheme);
        expect(out).toHaveLength(scheme.stops.length);
        for (const c of out) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });
    it('an achromatic seed (grey) stays grey under hue rotation — colour-theory-honest', () => {
      const out = harmonize('#808080', schemeById('triadic'));
      for (const c of out) expect(hueOf(c)).toBeNull(); // no hue to rotate → all grey
    });
    it('pure black/white seeds never throw and stay visible after clamping', () => {
      for (const seedHex of ['#000000', '#ffffff']) {
        const out = harmonize(seedHex, schemeById('monochromatic'));
        expect(out.length).toBe(4);
        for (const c of out) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });
    it('unparseable seed → best effort, never throws', () => {
      expect(harmonize('tomato', schemeById('triadic'))).toEqual(['tomato']);
      expect(harmonize(undefined, schemeById('triadic'))).toEqual([]);
    });
  });
});

describe('hostile fill never yields an invalid #NaN colour (cont.98 batch-15)', () => {
  const HEX = /^#[0-9a-f]{6}$/;
  it('an oversized / out-of-range rgb seed still produces valid hex for every stop', () => {
    // A persisted/capsule item fill is untrusted. `rgb(<400 nines>)` -> Infinity, `rgb(999,...)` > 255;
    // before the parseRgb clamp these poisoned the HSL math into NaN and toHex emitted '#NaNNaNNaN'.
    for (const seed of [`rgb(${'9'.repeat(400)},0,0)`, 'rgb(999,0,0)', 'rgb(300,300,300)']) {
      const out = harmonize(seed, schemeById('complementary'));
      expect(out.length).toBeGreaterThan(0);
      for (const c of out) expect(c).toMatch(HEX);
    }
  });
});
