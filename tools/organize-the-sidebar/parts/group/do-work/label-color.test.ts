// packages/group/do-work/label-color.test.ts
//
// Pure proof of the deterministic label→colour primitive. No DOM. Covers determinism/stability, prefix- and
// case-insensitivity (#Sample / @sample / sample are ONE colour), a well-formed HSL bg/fg pair, hue spread
// across distinct labels, and the empty/degenerate input.

import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { labelColor, normalizeLabel } from '../../../do-work/label-color.ts';

describe('labelColor', () => {
  it('is deterministic — the same label always yields the identical colour', () => {
    expect(labelColor('sample')).toEqual(labelColor('sample'));
    expect(labelColor('roadmap').hue).toBe(labelColor('roadmap').hue);
  });

  it('is prefix- and case-insensitive: #Sample / @sample / sample map to ONE colour', () => {
    const base = labelColor('sample').hue;
    expect(labelColor('#Sample').hue).toBe(base);
    expect(labelColor('@sample').hue).toBe(base);
    expect(labelColor('  SAMPLE  ').hue).toBe(base);
    expect(normalizeLabel('##@Sample  ')).toBe('sample');
  });

  it('emits a well-formed HSL bg/fg pair with the SAME hue (contrast-safe by construction)', () => {
    const c = labelColor('design');
    expect(c.bg).toBe(`hsl(${c.hue}, 68%, 90%)`); // light pastel bg
    expect(c.fg).toBe(`hsl(${c.hue}, 72%, 30%)`); // dark same-hue ink
    expect(c.hue).toBeGreaterThanOrEqual(0);
    expect(c.hue).toBeLessThan(360);
  });

  it('spreads distinct labels across the hue wheel (not all clustered on one colour)', () => {
    const labels = ['sample', 'roadmap', 'design', 'urgent', 'idea', 'bug', 'later', 'q3', 'brand', 'ship'];
    const hues = new Set(labels.map((l) => labelColor(l).hue));
    // a good hash gives near-distinct hues; require a strong majority to be distinct (no catastrophic collision).
    expect(hues.size).toBeGreaterThanOrEqual(labels.length - 1);
  });

  it('different labels usually differ; empty/degenerate input still yields a valid colour', () => {
    expect(labelColor('a').hue).not.toBe(labelColor('b').hue);
    const empty = labelColor('#');
    expect(empty.key).toBe('');
    expect(empty.hue).toBeGreaterThanOrEqual(0);
    expect(empty.hue).toBeLessThan(360);
  });
});
