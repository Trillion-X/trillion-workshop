// Proof for card elevation: level 0/non-finite is 'none', a positive level is a two-layer raised shadow
// that grows with the level, a negative level is an inset (pressed) shadow, and extreme levels clamp
// (finite CSS, bounded alpha). The named presets are DATA over the one computed formula.
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { elevationShadow, ELEVATION_LEVELS } from '../../../do-work/elevation-shadow.ts';

// Largest alpha in a shadow string (there may be several rgba layers).
const maxAlpha = (s: string) => Math.max(0, ...[...s.matchAll(/rgba\([^)]*?,\s*([0-9.]+)\)/g)].map((m) => Number(m[1])));
// First blur radius (the 3rd length token of the first layer) — a rough "how big" proxy.
const firstBlur = (s: string) => {
  const m = s.match(/(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px/);
  return m ? Number(m[2]) : 0;
};

describe('elevation-shadow — elevationShadow', () => {
  it('is "none" at level 0 or a non-finite level (byte-identical to an unstyled card)', () => {
    expect(elevationShadow(0)).toBe('none');
    expect(elevationShadow(NaN)).toBe('none');
    expect(elevationShadow(Infinity)).toBe('none'); // non-finite guard fires before clamp
  });

  it('a positive level is a RAISED two-layer drop shadow (no inset)', () => {
    const s = elevationShadow(2);
    expect(s).toContain('rgba(15, 23, 42');
    expect(s.includes('inset')).toBe(false);
    expect(s.split(',').filter((p) => p.includes('px')).length).toBeGreaterThanOrEqual(2); // two layers
  });

  it('grows with the level (a higher level = a bigger, darker shadow)', () => {
    const low = elevationShadow(1);
    const high = elevationShadow(6);
    expect(firstBlur(high)).toBeGreaterThan(firstBlur(low));
    expect(maxAlpha(high)).toBeGreaterThan(maxAlpha(low));
  });

  it('a negative level is an INSET (pressed) shadow', () => {
    const s = elevationShadow(-2);
    expect(s.startsWith('inset')).toBe(true);
    expect(s).toContain('rgba(15, 23, 42');
  });

  it('clamps an extreme level: finite CSS, bounded alpha, no NaN', () => {
    const s = elevationShadow(1000);
    expect(s.includes('NaN')).toBe(false);
    expect(maxAlpha(s)).toBeLessThanOrEqual(0.34);
  });
});

describe('elevation-shadow — ELEVATION_LEVELS', () => {
  it('every preset value (blank aside) resolves to a shadow through the same formula', () => {
    for (const p of ELEVATION_LEVELS) {
      const shadow = elevationShadow(Number(p.value) || 0);
      if (p.value === '') expect(shadow).toBe('none');
      else expect(shadow).not.toBe('none');
    }
  });
  it('ships a flat default plus raised and pressed presets', () => {
    expect(ELEVATION_LEVELS[0]).toEqual({ value: '', label: 'Flat' });
    expect(ELEVATION_LEVELS.some((p) => Number(p.value) < 0)).toBe(true); // the emergent inset look is surfaced
  });
});
