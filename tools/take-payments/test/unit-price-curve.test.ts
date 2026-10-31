import { describe, expect, it } from './expect.mjs';
import type { CommercialPriceOption } from '../../funnels-and-offers/read-data/read-offers.ts';
import { curveAmountCents, paidMatchesCurve, normalizeCurve } from '../read-data/unit-price-curve.ts';

// A worked configuration: $1000/mo base, 1000 seats included, then the
// decelerating seat curve (10c -> 5c -> 1c). This is DATA — the functions below never
// name it; delete it and drop in any other curve and the same code prices/validates it.
const PLAN: CommercialPriceOption = {
  id: 'price:bakery:monthly',
  label: '$1,000/mo',
  amount_cents: 100_000,
  currency: 'usd',
  interval: 'month',
  trial_days: 7,
  included_units: 1_000,
  unit_price_curve: [
    { up_to_units: 100_000, unit_cents: 10 },
    { up_to_units: 1_000_000, unit_cents: 5 },
    { up_to_units: null, unit_cents: 1 },
  ],
};

describe('curveAmountCents — decelerating seat curve (worked values)', () => {
  it.each([
    [1, 100_000],
    [1_000, 100_000],
    [1_001, 100_010],
    [2_000, 110_000],
    [10_000, 190_000],
    [100_000, 1_090_000],
    [100_001, 1_090_005],
    [1_000_000, 5_590_000],
    [1_000_001, 5_590_001],
    [10_000_000, 14_590_000],
  ])('N=%i seats -> %i cents', (seats, cents) => {
    expect(curveAmountCents(PLAN, seats)).toBe(BigInt(cents));
  });

  it('a count at or below the included tier is exactly the base', () => {
    expect(curveAmountCents(PLAN, 0)).toBe(100_000n);
    expect(curveAmountCents(PLAN, 500)).toBe(100_000n);
    expect(curveAmountCents(PLAN, 1_000)).toBe(100_000n);
  });
});

describe('paidMatchesCurve — the exact inverse image of the evaluator (fail-closed)', () => {
  it('accepts every amount some seat count produces', () => {
    for (const n of [1_000, 1_001, 2_000, 99_999, 100_000, 100_001, 500_000, 1_000_000, 1_000_001, 9_999_999]) {
      const amount = Number(curveAmountCents(PLAN, n));
      expect(paidMatchesCurve(PLAN, amount)).toBe(true);
    }
  });
  it('rejects an off-curve amount no seat count produces', () => {
    expect(paidMatchesCurve(PLAN, 100_001)).toBe(false); // between N=1000 (100000) and N=1001 (100010)
    expect(paidMatchesCurve(PLAN, 1_090_001)).toBe(false); // no N yields it
    expect(paidMatchesCurve(PLAN, 100_005)).toBe(false); // 5c is a lower band; band1 quantizes to 10c
  });
  it('rejects below base and negative/NaN', () => {
    expect(paidMatchesCurve(PLAN, 99_999)).toBe(false);
    expect(paidMatchesCurve(PLAN, -1)).toBe(false);
    expect(paidMatchesCurve(PLAN, Number.NaN)).toBe(false);
  });
  it('accepts exactly the base (buyer at or below the included tier)', () => {
    expect(paidMatchesCurve(PLAN, 100_000)).toBe(true);
  });
  it('band-boundary transitions are exact', () => {
    expect(paidMatchesCurve(PLAN, 1_090_000)).toBe(true);  // N=100,000 (end of 10c band)
    expect(paidMatchesCurve(PLAN, 1_090_005)).toBe(true);  // N=100,001 (first 5c unit)
    expect(paidMatchesCurve(PLAN, 5_590_000)).toBe(true);  // N=1,000,000 (end of 5c band)
    expect(paidMatchesCurve(PLAN, 5_590_001)).toBe(true);  // N=1,000,001 (first 1c unit)
  });
});

describe('legacy flat rate is a degenerate one-band curve (no special-casing, existing offers unbroken)', () => {
  const PRO: CommercialPriceOption = {
    id: 'price:pro', label: '$200/mo', amount_cents: 20_000, currency: 'usd',
    included_units: 100, additional_unit_amount_cents: 25,
  };
  it('prices the same as the old flat metering', () => {
    expect(curveAmountCents(PRO, 100)).toBe(20_000n);
    expect(curveAmountCents(PRO, 101)).toBe(20_025n);
    expect(curveAmountCents(PRO, 200)).toBe(22_500n);
  });
  it('the gate accepts base + whole 25c multiples, rejects off-rate', () => {
    expect(paidMatchesCurve(PRO, 20_000)).toBe(true);
    expect(paidMatchesCurve(PRO, 22_500)).toBe(true);
    expect(paidMatchesCurve(PRO, 20_010)).toBe(false); // not a 25c multiple
    expect(normalizeCurve(PRO)).toEqual([{ upTo: null, unitCents: 25n }]);
  });
});

describe('flat offer (no metering) — base only', () => {
  const FLAT: CommercialPriceOption = { id: 'price:flat', label: '$49', amount_cents: 4_900, currency: 'usd' };
  it('any count is the base; only the base amount is accepted', () => {
    expect(curveAmountCents(FLAT, 5)).toBe(4_900n);
    expect(paidMatchesCurve(FLAT, 4_900)).toBe(true);
    expect(paidMatchesCurve(FLAT, 4_901)).toBe(false);
    expect(normalizeCurve(FLAT)).toEqual([]);
  });
});

describe('adversarial: zero-rate band advances the boundary', () => {
  // A free band followed by a priced band. The stale-boundary bug would accept 100_015.
  const ZERO_BAND: CommercialPriceOption = {
    id: 'price:z', label: 'z', amount_cents: 100_000, included_units: 1_000,
    unit_price_curve: [
      { up_to_units: 1_002, unit_cents: 0 },
      { up_to_units: 1_004, unit_cents: 5 },
    ],
  };
  it('prices free units at 0 and later units at the real rate', () => {
    expect(curveAmountCents(ZERO_BAND, 1_002)).toBe(100_000n); // 2 free units
    expect(curveAmountCents(ZERO_BAND, 1_003)).toBe(100_005n);
    expect(curveAmountCents(ZERO_BAND, 1_004)).toBe(100_010n);
  });
  it('the gate does NOT accept an amount the boundary math forbids', () => {
    expect(paidMatchesCurve(ZERO_BAND, 100_015)).toBe(false); // stale-boundary bug would say true
    expect(paidMatchesCurve(ZERO_BAND, 100_005)).toBe(true);
    expect(paidMatchesCurve(ZERO_BAND, 100_010)).toBe(true);
  });
});

describe('curve authoring order does not change the math (bands sorted by boundary)', () => {
  const SCRAMBLED: CommercialPriceOption = {
    id: 'price:s', label: 's', amount_cents: 100_000, included_units: 1_000,
    unit_price_curve: [
      { up_to_units: null, unit_cents: 1 },
      { up_to_units: 100_000, unit_cents: 10 },
      { up_to_units: 1_000_000, unit_cents: 5 },
    ],
  };
  it('produces identical prices to the ascending-order PLAN', () => {
    for (const n of [1_001, 100_000, 100_001, 1_000_000, 1_000_001]) {
      expect(curveAmountCents(SCRAMBLED, n)).toBe(curveAmountCents(PLAN, n));
    }
  });
});
