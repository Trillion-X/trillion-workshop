// packages/group/do-work/color-harmony.test.ts
//
// Pure proof of the colour-harmony primitive. No DOM. Covers the HSL round-trip, each scheme's core hue
// relationship (complementary +180, triadic +120, analogous +30, tetradic +90), valid hex output, determinism,
// the injected-scheme extensibility, and the malformed-seed guard.

import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { harmonize, hexToHsl, hslToHex, HARMONY_SCHEMES, type HarmonyScheme } from '../../../do-work/color-harmony.ts';

const HEX = /^#[0-9a-f]{6}$/;
const hueOf = (hex: string) => hexToHsl(hex).h;
/** circular hue distance 0..180 */
const hueDist = (a: number, b: number) => {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
};
const scheme = (id: string) => HARMONY_SCHEMES.find((s) => s.id === id)!;

describe('color-harmony', () => {
  it('HSL round-trips a colour within rounding tolerance', () => {
    const back = hslToHex(hexToHsl('#3b82f6').h, hexToHsl('#3b82f6').s, hexToHsl('#3b82f6').l);
    const a = hexToHsl('#3b82f6');
    const b = hexToHsl(back);
    expect(hueDist(a.h, b.h)).toBeLessThan(2);
  });

  it('every scheme yields `count` valid pastel hex colours', () => {
    for (const s of HARMONY_SCHEMES) {
      const colors = harmonize('#3b82f6', s, 5);
      expect(colors).toHaveLength(5);
      for (const c of colors) expect(c).toMatch(HEX);
      expect(new Set(colors).size).toBe(5); // no duplicate colours (offsets are distinct)
    }
  });

  it('encodes each scheme’s core hue relationship (measured off the SEED hue at fixed S/L)', () => {
    const seedHue = harmonize('#3b82f6', scheme('complementary'), 5).map(hueOf)[0]; // colour[0] = seed hue
    expect(hueDist(hueOf(harmonize('#3b82f6', scheme('complementary'), 5)[1]), (seedHue + 180) % 360)).toBeLessThan(4);
    expect(hueDist(hueOf(harmonize('#3b82f6', scheme('triadic'), 5)[1]), (seedHue + 120) % 360)).toBeLessThan(4);
    expect(hueDist(hueOf(harmonize('#3b82f6', scheme('analogous'), 5)[1]), (seedHue + 30) % 360)).toBeLessThan(4);
    expect(hueDist(hueOf(harmonize('#3b82f6', scheme('tetradic'), 5)[1]), (seedHue + 90) % 360)).toBeLessThan(4);
  });

  it('is deterministic — same seed + scheme → identical palette', () => {
    expect(harmonize('#22c55e', scheme('triadic'))).toEqual(harmonize('#22c55e', scheme('triadic')));
  });

  it('is injected-map extensible: a CUSTOM scheme rotates by its own offsets (zero engine change)', () => {
    const custom: HarmonyScheme = { id: 'split', label: 'Split', offsets: [0, 150, 210] };
    const colors = harmonize('#3b82f6', custom, 3);
    const seedHue = hueOf(colors[0]);
    expect(hueDist(hueOf(colors[1]), (seedHue + 150) % 360)).toBeLessThan(4);
    expect(hueDist(hueOf(colors[2]), (seedHue + 210) % 360)).toBeLessThan(4);
  });

  it('a malformed seed still yields valid hex (fail-safe, never throws)', () => {
    for (const c of harmonize('not-a-color', scheme('triadic'))) expect(c).toMatch(HEX);
  });
});
