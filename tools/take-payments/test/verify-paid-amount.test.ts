// packages/checkout/read-data/verify-paid-amount.test.ts
//
// FU-1 fail-closed money gate. Adversarial: exact match allows; underpay,
// overpay, currency mismatch, missing/invalid amount, and an offer with no
// declared price all DENY. Multi-option offers allow ANY declared price.
import { describe, expect, it } from './expect.mjs';
import type { CheckoutOffer } from '../../funnels-and-offers/read-data/read-offers.ts';
import {
  assertPaidAmountMatchesOffer,
  offerAcceptablePrices,
  paidAmountMatchesOffer,
  normalizePaidCurrency,
  paidAmountMatchesSignedQuote,
} from '../read-data/verify-paid-amount.ts';

function offer(priceOptions: Array<{ amount_cents?: number; currency?: string; additional_unit_amount_cents?: number }>): CheckoutOffer {
  return {
    access_refs: ['product-access:x'],
    benefits: [],
    content_refs: [],
    curriculum: [],
    id: 'offer:test',
    label: 'Test',
    price_options: priceOptions.map((p, i) => ({ id: `price:${i}`, label: `P${i}`, ...p })),
    sort_order: 0,
    summary: '',
  };
}

describe('metered seat add-on money gate', () => {
  // Pro: $200 base for 100 seats, +$1/seat beyond.
  const pro = offer([{ amount_cents: 20000, currency: 'usd', additional_unit_amount_cents: 100 }]);
  it('accepts the included-tier base amount', () => {
    expect(paidAmountMatchesOffer(pro, { amountCents: 20000, currency: 'usd' })).toBe(true);
  });
  it('accepts an on-curve add-on total (150 seats = 20000 + 50*100)', () => {
    expect(paidAmountMatchesOffer(pro, { amountCents: 25000, currency: 'usd' })).toBe(true);
  });
  it('denies an off-curve amount that no whole seat count produces', () => {
    expect(paidAmountMatchesOffer(pro, { amountCents: 25050, currency: 'usd' })).toBe(false);
  });
  it('denies any amount below the included base', () => {
    expect(paidAmountMatchesOffer(pro, { amountCents: 19900, currency: 'usd' })).toBe(false);
  });
  it('a flat option still requires an EXACT base match (no add-on rate)', () => {
    expect(paidAmountMatchesOffer(offer([{ amount_cents: 5000, currency: 'usd' }]), { amountCents: 5100, currency: 'usd' })).toBe(false);
    expect(paidAmountMatchesOffer(offer([{ amount_cents: 5000, currency: 'usd' }]), { amountCents: 5000, currency: 'usd' })).toBe(true);
  });
});

describe('normalizePaidCurrency', () => {
  it('lowercases, trims, defaults usd', () => {
    expect(normalizePaidCurrency('USD')).toBe('usd');
    expect(normalizePaidCurrency('  Eur ')).toBe('eur');
    expect(normalizePaidCurrency(undefined)).toBe('usd');
    expect(normalizePaidCurrency('')).toBe('usd');
  });
});

describe('offerAcceptablePrices (SSOT)', () => {
  it('extracts only priced options, normalizing currency', () => {
    const o = offer([{ amount_cents: 18000, currency: 'USD' }, { label: 'free-no-amount' } as any, { amount_cents: 5000 }]);
    expect(offerAcceptablePrices(o)).toEqual([
      { amountCents: 18000, currency: 'usd' },
      { amountCents: 5000, currency: 'usd' },
    ]);
  });
});

describe('paidAmountMatchesOffer', () => {
  it('EXACT match allows', () => {
    expect(paidAmountMatchesOffer(offer([{ amount_cents: 18000, currency: 'usd' }]), { amountCents: 18000, currency: 'usd' })).toBe(true);
  });
  it('underpay denies', () => {
    expect(paidAmountMatchesOffer(offer([{ amount_cents: 18000, currency: 'usd' }]), { amountCents: 100, currency: 'usd' })).toBe(false);
  });
  it('overpay denies (must be an exactly-declared price)', () => {
    expect(paidAmountMatchesOffer(offer([{ amount_cents: 18000, currency: 'usd' }]), { amountCents: 999999, currency: 'usd' })).toBe(false);
  });
  it('currency mismatch denies', () => {
    expect(paidAmountMatchesOffer(offer([{ amount_cents: 18000, currency: 'usd' }]), { amountCents: 18000, currency: 'eur' })).toBe(false);
  });
  it('offer with no declared price denies (cannot verify a paid grant)', () => {
    expect(paidAmountMatchesOffer(offer([]), { amountCents: 18000, currency: 'usd' })).toBe(false);
  });
  it('multi-option offer allows ANY declared price (one-time OR installment)', () => {
    const o = offer([{ amount_cents: 18000, currency: 'usd' }, { amount_cents: 6000, currency: 'usd' }]);
    expect(paidAmountMatchesOffer(o, { amountCents: 6000, currency: 'usd' })).toBe(true);
    expect(paidAmountMatchesOffer(o, { amountCents: 18000, currency: 'usd' })).toBe(true);
    expect(paidAmountMatchesOffer(o, { amountCents: 12000, currency: 'usd' })).toBe(false);
  });
  it('case-insensitive currency match', () => {
    expect(paidAmountMatchesOffer(offer([{ amount_cents: 18000, currency: 'USD' }]), { amountCents: 18000, currency: 'usd' })).toBe(true);
  });
});

describe('assertPaidAmountMatchesOffer (fail-closed)', () => {
  it('allows an exact match (no throw)', () => {
    expect(() => assertPaidAmountMatchesOffer(offer([{ amount_cents: 18000, currency: 'usd' }]), { amountCents: 18000, currency: 'usd' })).not.toThrow();
  });
  it('throws on missing amount (NaN)', () => {
    expect(() => assertPaidAmountMatchesOffer(offer([{ amount_cents: 18000, currency: 'usd' }]), { amountCents: NaN, currency: 'usd' })).toThrow(/missing or invalid/);
  });
  it('throws on negative amount', () => {
    expect(() => assertPaidAmountMatchesOffer(offer([{ amount_cents: 18000, currency: 'usd' }]), { amountCents: -1, currency: 'usd' })).toThrow(/missing or invalid/);
  });
  it('throws on price-swap (paid a cheap price, claim mismatched offer)', () => {
    expect(() => assertPaidAmountMatchesOffer(offer([{ amount_cents: 180000, currency: 'usd' }]), { amountCents: 100, currency: 'usd' })).toThrow(/does not match any price/);
  });
  it('throws on currency mismatch', () => {
    expect(() => assertPaidAmountMatchesOffer(offer([{ amount_cents: 18000, currency: 'usd' }]), { amountCents: 18000, currency: 'eur' })).toThrow(/does not match any price/);
  });
});

describe('paidAmountMatchesSignedQuote', () => {
  const contribution: CheckoutOffer = {
    ...offer([{ amount_cents: 1000, currency: 'usd' }]),
    price_options: [{
      amount_cents: 1000,
      currency: 'usd',
      id: 'price:monthly',
      interval: 'month',
      label: 'Monthly',
      payment_timing: 'subscription',
      voluntary_amount_policy: {
        allow_custom: true,
        currency: 'usd',
        max_cents: 100000,
        min_cents: 100,
        suggested_cents: [500, 1000, 2500],
      },
    }],
  };
  const signed = {
    amountCents: 1777,
    cadence: 'month',
    currency: 'usd',
    priceOptionId: 'price:monthly',
  };

  it('accepts provider money equal to the signed custom amount inside policy', () => {
    expect(paidAmountMatchesSignedQuote(
      contribution,
      { amountCents: 1777, currency: 'USD' },
      signed,
    )).toBe(true);
  });

  it.each([
    [{ amountCents: 1776, currency: 'usd' }, signed],
    [{ amountCents: 1777, currency: 'eur' }, signed],
    [{ amountCents: 1777, currency: 'usd' }, { ...signed, priceOptionId: 'price:missing' }],
    [{ amountCents: 1777, currency: 'usd' }, { ...signed, cadence: 'one_time' }],
    [{ amountCents: 99, currency: 'usd' }, { ...signed, amountCents: 99 }],
    [{ amountCents: 100001, currency: 'usd' }, { ...signed, amountCents: 100001 }],
  ])('rejects provider, identity, cadence, or policy mismatch', (paid, quote) => {
    expect(paidAmountMatchesSignedQuote(contribution, paid, quote)).toBe(false);
  });
});
