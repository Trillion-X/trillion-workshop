// Vendored unchanged except for import paths from bitfield-packages/packages/progression-evaluator/read-data/band-membership.test.ts.
// packages/progression-evaluator/read-data/band-membership.test.ts
//
// =============================================================================
// RED-TEAM — the canonical band-membership leaf (SSOT bedrock)
// =============================================================================
//
// This leaf is the ONE definition of "which half-open [min,max) band contains a
// value, and what is its payload." Three call sites (the `band` measure op, the
// mental-readout tone/caption derivation, and — as a follow-up — the generic
// measure->projection shaper's band verb) delegate to it. The test pins the
// bracketed half-open semantics that a prior duplicate GOT WRONG (matching on
// min-OR-max first-hit instead of min<=value<max), so the divergence cannot
// silently return.
// =============================================================================

import { describe, expect, it } from '../../../match-community-members/test/vitest-shim.mjs';
import { bandContains, bandIndexOf, bandPayloadOf, type Band } from '../../read-data/band-membership.ts';

// The exact tone bands the mental-readout config ships — the divergence case.
const TONE: Band[] = [
  { max: 0.34, payload: 'critical' },
  { min: 0.34, max: 0.67, payload: 'caution' },
  { min: 0.67, payload: 'positive' },
];

describe('band-membership — canonical half-open [min,max) membership (SSOT)', () => {
  it('BRACKETED (the divergence case): a value above a middle band\'s max lands in the OPEN top band, not the middle', () => {
    // The buggy min-OR-max first-hit variant returned "caution" for 1.0 because
    // the middle band's min (0.34) is satisfied. Bracketed membership requires
    // 0.34 <= v < 0.67, so 1.0 must fall through to the open-top "positive".
    expect(bandPayloadOf(1.0, TONE)).toBe('positive');
    expect(bandPayloadOf(0.9, TONE)).toBe('positive');
    expect(bandPayloadOf(0.67, TONE)).toBe('positive'); // min is inclusive
  });

  it('middle band is [0.34, 0.67): includes its min, excludes its max', () => {
    expect(bandPayloadOf(0.34, TONE)).toBe('caution'); // inclusive lower
    expect(bandPayloadOf(0.5, TONE)).toBe('caution');
    expect(bandPayloadOf(0.6699, TONE)).toBe('caution');
  });

  it('open-bottom band (max only) is (-inf, 0.34)', () => {
    expect(bandPayloadOf(0, TONE)).toBe('critical');
    expect(bandPayloadOf(-5, TONE)).toBe('critical');
    expect(bandPayloadOf(0.3399, TONE)).toBe('critical');
  });

  it('first matching band wins when bands overlap', () => {
    const overlap: Band[] = [{ min: 0, max: 10, payload: 'a' }, { min: 5, max: 10, payload: 'b' }];
    expect(bandPayloadOf(7, overlap)).toBe('a');
  });

  it('payload falls back to the band INDEX when omitted (historical bandOp behavior)', () => {
    const idxBands: Band[] = [{ max: 1 }, { min: 1, max: 2 }, { min: 2 }];
    expect(bandPayloadOf(0.5, idxBands)).toBe(0);
    expect(bandPayloadOf(1.5, idxBands)).toBe(1);
    expect(bandPayloadOf(9, idxBands)).toBe(2);
  });

  it('no match -> undefined; non-finite value -> undefined; empty/undefined bands -> undefined / -1', () => {
    const gap: Band[] = [{ min: 0, max: 1, payload: 'x' }, { min: 5, max: 6, payload: 'y' }];
    expect(bandPayloadOf(3, gap)).toBeUndefined();
    expect(bandPayloadOf(NaN, TONE)).toBeUndefined();
    expect(bandPayloadOf(Infinity, TONE)).toBeUndefined();
    expect(bandPayloadOf(0.5, undefined)).toBeUndefined();
    expect(bandIndexOf(0.5, [])).toBe(-1);
    expect(bandIndexOf(0.5, undefined)).toBe(-1);
  });

  it('bandIndexOf returns the matching band position', () => {
    expect(bandIndexOf(1.0, TONE)).toBe(2);
    expect(bandIndexOf(0.5, TONE)).toBe(1);
    expect(bandIndexOf(0.1, TONE)).toBe(0);
  });

  it('bandContains (the atom): min inclusive, max exclusive, absent bounds infinite', () => {
    expect(bandContains(5, { min: 0, max: 10 })).toBe(true);
    expect(bandContains(0, { min: 0, max: 10 })).toBe(true);  // min inclusive
    expect(bandContains(10, { min: 0, max: 10 })).toBe(false); // max exclusive
    expect(bandContains(-1, { max: 10 })).toBe(true);          // -inf min
    expect(bandContains(999, { min: 10 })).toBe(true);         // +inf max
    expect(bandContains(NaN, { min: 0, max: 10 })).toBe(false);
    expect(bandContains(5, undefined)).toBe(false);
  });

  // A GAP-THRESHOLD band (a deliberate uncovered middle range) is how a value
  // escalates through THREE visual states with only two thresholds: the covered
  // ends emit their payload, the uncovered middle returns undefined so the
  // consumer falls back to its default. This is the exact shape the apeak
  // check-in "chip tone" ships: count [1,3)->neutral (subtle), [3,8)->UNCOVERED
  // (chipTone absent -> the accent default), [8,+inf)->positive (celebratory).
  // Verifies the gap genuinely yields undefined (not the nearest band).
  it('gap-threshold band: covered ends emit, the uncovered middle returns undefined (the 3-state escalation)', () => {
    const CHIP_TONE: Band[] = [
      { min: 1, max: 3, out: 'neutral' },
      { min: 8, out: 'positive' },
    ];
    const payload = (n: number) => {
      const i = bandIndexOf(n, CHIP_TONE);
      return i < 0 ? undefined : CHIP_TONE[i].out;
    };
    expect(payload(2)).toBe('neutral');   // Building awareness -> subtle
    expect(payload(5)).toBeUndefined();   // Consistent -> uncovered -> accent default
    expect(payload(3)).toBeUndefined();   // boundary: [1,3) excludes 3 -> accent
    expect(payload(10)).toBe('positive'); // Locked in -> celebratory
    expect(payload(8)).toBe('positive');  // boundary: [8,+inf) includes 8
  });
});
