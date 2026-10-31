// The quote: what a buyer is charged, worked out from the seller's offer rows. A synthetic bakery's rows; the
// arithmetic is what is proved. Covers a trial (nothing due today but not free), per-unit pricing with a floor, a
// buyer-chosen amount inside the seller's range, a different first invoice, a checkout code that degrades softly, and
// a price that writes its own charges.
import { describe, expect, it } from './expect.mjs';
import { buildCheckoutMaterialQuote, buildCheckoutQuote } from '../read-data/checkout-quote.ts';
import { readCheckoutCodeAdjustments } from '../read-data/read-code-adjustments.ts';
import { readCheckoutOffers } from '../../funnels-and-offers/read-data/read-offers.ts';
import type { CheckoutOffer } from '../../funnels-and-offers/read-data/read-offers.ts';

const box: CheckoutOffer = {
  access_refs: ['access:bread-box'],
  benefits: [],
  content_refs: [],
  curriculum: [],
  id: 'offer:bread-box',
  label: 'Bread box',
  price_options: [{
    amount_cents: 1200, currency: 'usd', id: 'price:box:monthly', interval: 'month', label: 'Monthly',
    payment_timing: 'subscription', trial_days: 7, included_units: 2,
  }],
  sort_order: 1,
  summary: 'A box of bread every month.',
};

const catering: CheckoutOffer = {
  ...box,
  id: 'offer:catering',
  label: 'Catering',
  price_options: [{
    amount_cents: 48000, currency: 'usd', id: 'price:catering:monthly', interval: 'month', label: 'Monthly',
    payment_timing: 'subscription', included_units: 20, additional_unit_amount_cents: 1500,
  }],
};

const input = { checkoutAttemptId: 'attempt-000000000001', checkoutStartedAt: '2026-01-02T03:04:05Z' };

describe('a trial and per-unit pricing', () => {
  it('a trial charges nothing today, is not free, and recurs at the full amount', () => {
    const quote = buildCheckoutMaterialQuote([box], { ...input, offerId: 'offer:bread-box', priceOptionId: 'price:box:monthly' });
    expect(quote.trialDays).toBe(7);
    expect(quote.amountDueTodayCents).toBe(0n);
    expect(quote.paymentMode).toBe('subscription');
    expect(quote.recurringAmountCents).toBe(1200n);
  });

  it('the included units cost the flat price and each unit beyond is priced by the offer', () => {
    const at = (unitCount: number) => buildCheckoutMaterialQuote([catering], { ...input, offerId: 'offer:catering', priceOptionId: 'price:catering:monthly', unitCount });
    expect(at(20).recurringAmountCents).toBe(48000n);
    expect(at(25).recurringAmountCents).toBe(48000n + 5n * 1500n);
  });

  it('a count below the included floor is lifted to it, so a buyer never underpays', () => {
    const quote = buildCheckoutMaterialQuote([catering], { ...input, offerId: 'offer:catering', priceOptionId: 'price:catering:monthly', unitCount: 3 });
    expect(quote.unitCount).toBe(20);
    expect(quote.recurringAmountCents).toBe(48000n);
  });

  it('a flat price is always exactly one unit, whatever count is asked for', () => {
    const flat: CheckoutOffer = { ...box, price_options: [{ amount_cents: 900, currency: 'usd', id: 'flat', label: 'Flat', payment_timing: 'subscription' }] };
    const quote = buildCheckoutMaterialQuote([flat], { ...input, offerId: 'offer:bread-box', priceOptionId: 'flat', unitCount: 999 });
    expect(quote.unitCount).toBe(1);
    expect(quote.recurringAmountCents).toBe(900n);
  });

  it('refuses an offer or a price the seller has not published', () => {
    expect(() => buildCheckoutMaterialQuote([box], { ...input, offerId: 'offer:none', priceOptionId: 'x' })).toThrow(/offer is not published/);
    expect(() => buildCheckoutMaterialQuote([box], { ...input, offerId: 'offer:bread-box', priceOptionId: 'x' })).toThrow(/price is not published/);
  });

  it('refuses an attempt id or start time that is not usable, rather than reading a clock', () => {
    expect(() => buildCheckoutMaterialQuote([box], { ...input, checkoutAttemptId: 'short', offerId: 'offer:bread-box', priceOptionId: 'price:box:monthly' })).toThrow(/start checkout again/);
    expect(() => buildCheckoutMaterialQuote([box], { ...input, checkoutStartedAt: 'yesterday', offerId: 'offer:bread-box', priceOptionId: 'price:box:monthly' })).toThrow(/start checkout again/);
  });
});

describe('an amount the buyer chooses', () => {
  const tip: CheckoutOffer = {
    ...box,
    id: 'offer:tip',
    price_options: [{
      amount_cents: 500, currency: 'usd', id: 'price:tip:once', label: 'Tip', payment_timing: 'one_time',
      voluntary_amount_policy: { allow_custom: true, currency: 'usd', max_cents: 50000, min_cents: 100, suggested_cents: [300, 500] },
    }],
  };
  const ask = (customerSelectedAmountCents: unknown, extra = {}) => buildCheckoutMaterialQuote([tip], { ...input, offerId: 'offer:tip', priceOptionId: 'price:tip:once', customerSelectedAmountCents: customerSelectedAmountCents as number, ...extra });

  it('uses the validated amount', () => {
    expect(ask(777).validatedAmountCents).toBe(777n);
    expect(ask(777).amountDueTodayCents).toBe(777n);
  });

  it('an exact zero is a free quote, not a refusal', () => {
    const quote = ask(0);
    expect(quote.paymentMode).toBe('free');
    expect(quote.amountDueTodayCents).toBe(0n);
  });

  it('refuses an amount outside the published range or not in whole minor units', () => {
    expect(() => ask(undefined)).toThrow(/valid amount/);
    expect(() => ask(50)).toThrow(/at least 100/);
    expect(() => ask(50001)).toThrow(/no greater than 50000/);
    expect(() => ask(10.5)).toThrow(/whole currency minor units/);
  });

  it('when custom amounts are off, only a published suggestion is accepted', () => {
    const fixed: CheckoutOffer = { ...tip, price_options: [{ ...tip.price_options[0], voluntary_amount_policy: { ...tip.price_options[0].voluntary_amount_policy!, allow_custom: false } }] };
    expect(() => buildCheckoutMaterialQuote([fixed], { ...input, offerId: 'offer:tip', priceOptionId: 'price:tip:once', customerSelectedAmountCents: 777 })).toThrow(/published contribution amounts/);
    expect(buildCheckoutMaterialQuote([fixed], { ...input, offerId: 'offer:tip', priceOptionId: 'price:tip:once', customerSelectedAmountCents: 300 }).validatedAmountCents).toBe(300n);
  });
});

describe('a first invoice that differs from the renewal', () => {
  const opening = (initial: number): CheckoutOffer => ({
    ...box,
    id: 'offer:opening',
    price_options: [{ amount_cents: 1000, currency: 'usd', id: 'price:opening', initial_amount_cents: initial, interval: 'month', label: 'Opening', payment_timing: 'subscription' }],
  });
  const ask = (offer: CheckoutOffer) => buildCheckoutMaterialQuote([offer], { ...input, offerId: 'offer:opening', priceOptionId: 'price:opening' });

  it('a larger first invoice is due today while the renewal stays', () => {
    const quote = ask(opening(4000));
    expect(quote.amountDueTodayCents).toBe(4000n);
    expect(quote.recurringAmountCents).toBe(1000n);
  });

  it('a smaller opening rate is an ordinary offer, not an error', () => {
    expect(ask(opening(600)).amountDueTodayCents).toBe(600n);
  });

  it('refuses an initial amount no invoice could be written from', () => {
    for (const bad of [0, -1, 1.5]) expect(() => ask(opening(bad))).toThrow(/initial subscription amount is invalid/i);
  });

  it('refuses a larger first invoice combined with a trial', () => {
    const offer = opening(4000);
    offer.price_options[0].trial_days = 7;
    expect(() => ask(offer)).toThrow(/cannot be combined with a deferred trial charge/i);
  });
});

describe('a checkout code', () => {
  const adjustments = readCheckoutCodeAdjustments([
    { kind: 'checkout-code-adjustment', id: 'adj:ten', label: 'Ten off', code: 'ten off', adjustment: { kind: 'percent', percent: 10 }, applies_to: { offer_ids: ['offer:catering'] } },
    { kind: 'checkout-code-adjustment', id: 'adj:retired', label: 'Retired', code: 'RETIRED', state: 'inactive', adjustment: { kind: 'percent', percent: 50 } },
  ]);
  const ask = (checkoutCode: string, offer = catering, price = 'price:catering:monthly') => buildCheckoutMaterialQuote([box, catering], { ...input, offerId: offer.id, priceOptionId: price, checkoutCode }, adjustments);

  it('takes the discount off, with the code matched however it is typed', () => {
    const quote = ask(' ten  off ');
    expect(quote.appliedAdjustment?.discountCents).toBe(4800n);
    expect(quote.recurringAmountCents).toBe(43200n);
  });

  it('an unknown, inactive or out-of-scope code falls back to full price with a notice, never an error', () => {
    expect(ask('NOPE').recurringAmountCents).toBe(48000n);
    expect(ask('NOPE').codeNotice).toMatch(/isn.t valid/);
    expect(ask('RETIRED').appliedAdjustment).toBeUndefined();
    const outOfScope = ask('TEN OFF', box, 'price:box:monthly');
    expect(outOfScope.codeNotice).toMatch(/doesn.t apply/);
    expect(outOfScope.recurringAmountCents).toBe(1200n);
  });
});

describe('a price that writes its own charges', () => {
  const [scheduled] = readCheckoutOffers([{
    kind: 'commercial-offer', id: 'offer:course', label: 'Course', sort_order: 1,
    price_options: [{
      id: 'price:course', label: 'Course', amount_cents: 4000, currency: 'usd', payment_timing: 'subscription', interval: 'month',
      charges: [{ amount_cents: 800, days_after_signup: 0 }, { amount_cents: 3200, days_after_signup: 7 }], repeat: { amount_cents: 4000, interval: 'month' },
    }],
  }]);

  it('is read as written: what is due today and the schedule agree', () => {
    const quote = buildCheckoutMaterialQuote([scheduled], { ...input, offerId: 'offer:course', priceOptionId: 'price:course' });
    expect(quote.schedule?.charges.map(charge => [charge.amountCents, charge.daysAfterSignup])).toEqual([[800n, 0], [3200n, 7]]);
    expect(quote.schedule?.repeat?.amountCents).toBe(4000n);
  });

  it('refuses a code on it rather than quietly charging the published amount', () => {
    const adjustments = readCheckoutCodeAdjustments([{ kind: 'checkout-code-adjustment', id: 'a', label: 'A', code: 'A', adjustment: { kind: 'percent', percent: 10 } }]);
    expect(() => buildCheckoutMaterialQuote([scheduled], { ...input, offerId: 'offer:course', priceOptionId: 'price:course', checkoutCode: 'A' }, adjustments)).toThrow(/states its own charges/);
  });
});

describe('starting a paid checkout needs the buyer\'s agreement', () => {
  it('refuses without billing and legal consent, and carries a valid customer through', () => {
    const base = { ...input, offerId: 'offer:bread-box', priceOptionId: 'price:box:monthly' };
    expect(() => buildCheckoutQuote([box], { ...base, consent: { billing: true, legal: false } })).toThrow(/Agree to the billing and legal terms/);
    const quote = buildCheckoutQuote([box], { ...base, consent: { billing: true, legal: true }, customer: { email: 'Ana@Example.com', firstName: 'Ana', lastName: 'Baker' } });
    expect(quote.customer).toMatchObject({ email: 'ana@example.com', name: 'Ana Baker' });
    expect(() => buildCheckoutQuote([box], { ...base, consent: { billing: true, legal: true }, customer: { email: 'nope', firstName: 'A', lastName: 'B' } })).toThrow(/valid email/);
  });
});
