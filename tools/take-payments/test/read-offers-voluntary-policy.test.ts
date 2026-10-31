import { describe, expect, it } from './expect.mjs';
import { readCheckoutOffers } from '../../funnels-and-offers/read-data/read-offers.ts';

/** One offer whose single price option carries exactly the fields the caller names.
 *
 *  The reader treats a voluntary_amount_policy that is PRESENT but not an object as a DATA error,
 *  and it asks with hasOwnProperty rather than a null check on purpose, so a fixture that always
 *  sets the key cannot express "this option has no policy". Building the option from a spread is
 *  what keeps that distinction available to the tests below. */
function offerWithPriceOption(priceOption: Record<string, unknown>) {
  return {
    records: [{
      access_refs: [],
      id: 'offer:contribution',
      kind: 'commercial-offer',
      label: 'Support',
      price_options: [{
        amount_cents: 1000,
        currency: 'USD',
        id: 'price:monthly',
        label: 'Monthly',
        ...priceOption,
      }],
    }],
  };
}

function offerWithPolicy(policy: unknown) {
  return offerWithPriceOption({ voluntary_amount_policy: policy });
}

describe('readCheckoutOffers voluntary amount policy', () => {
  it('preserves the canonical policy DATA shape', () => {
    const [offer] = readCheckoutOffers(offerWithPolicy({
      allow_custom: true,
      currency: 'USD',
      max_cents: 500000,
      min_cents: 100,
      highlighted_cents: 50000,
      highlight_label: 'Most picked',
      suggested_cents: [2500, 5000, 10000, 25000, 50000, 100000, 200000, 250000, 500000],
    }));
    expect(offer.price_options[0].voluntary_amount_policy).toEqual({
      allow_custom: true,
      currency: 'usd',
      highlighted_cents: 50000,
      highlight_label: 'Most picked',
      max_cents: 500000,
      min_cents: 100,
      suggested_cents: [2500, 5000, 10000, 25000, 50000, 100000, 200000, 250000, 500000],
    });
  });

  it('preserves a declared first-subscription-invoice amount', () => {
    const [offer] = readCheckoutOffers(offerWithPriceOption({
      initial_amount_cents: 50000,
      payment_timing: 'subscription',
    }));
    expect(offer.price_options[0].initial_amount_cents).toBe(50000);
  });

  it('normalizes documented legacy long names without changing the public shape', () => {
    const [offer] = readCheckoutOffers(offerWithPolicy({
      enabled: true,
      allow_custom: true,
      maximum_amount_cents: 100000,
      minimum_amount_cents: 100,
      suggested_amount_cents: [500, 1000, 2500],
    }));
    expect(offer.price_options[0].voluntary_amount_policy).toEqual({
      allow_custom: true,
      currency: 'usd',
      max_cents: 100000,
      min_cents: 100,
      suggested_cents: [500, 1000, 2500],
    });
  });

  it.each([
    [{ allow_custom: true, currency: 'usd', suggested_cents: [] }, /min_cents/i],
    [{ allow_custom: 'yes', currency: 'usd', min_cents: 100, suggested_cents: [500] }, /allow_custom/i],
    [{ allow_custom: true, currency: 'US', min_cents: 100, suggested_cents: [500] }, /currency/i],
    [{ allow_custom: true, currency: 'usd', min_cents: 100, suggested_cents: ['500'] }, /suggested_cents/i],
    [{ allow_custom: true, currency: 'usd', max_cents: 200, min_cents: 300, suggested_cents: [] }, /max_cents/i],
    [{ allow_custom: true, currency: 'usd', highlighted_cents: 500, min_cents: 100, suggested_cents: [500] }, /highlight metadata/i],
    [{ allow_custom: true, currency: 'usd', highlight_label: 'Most popular', min_cents: 100, suggested_cents: [500] }, /highlight metadata/i],
    [{ allow_custom: true, currency: 'usd', highlighted_cents: 1000, highlight_label: 'Most popular', min_cents: 100, suggested_cents: [500] }, /highlighted_cents/i],
    ['not-a-policy', /must be an object/i],
    [null, /must be an object/i],
  ])('fails closed on malformed declared policy DATA', (policy, message) => {
    expect(() => readCheckoutOffers(offerWithPolicy(policy)))
      .toThrow(message as RegExp);
  });
});
