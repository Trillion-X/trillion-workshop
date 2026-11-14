import { describe, expect, it } from './expect.mjs';
import { readCheckoutOffers, suggestionKey } from '../../funnels-and-offers/read-data/read-offers.ts';

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

describe('readCheckoutOffers fixed suggested amounts named by a list of rows', () => {
  const amountRows = { list: 'list:tip-amounts', value_field: 'cents', shown_field: 'shown' };
  const lists = (rows: unknown[]) => new Map([[suggestionKey('offer:contribution', 'list:tip-amounts'), rows]]);
  const policy = (extra: Record<string, unknown>) => ({ allow_custom: true, currency: 'usd', min_cents: 100, suggestion_rows: amountRows, ...extra });

  it('offers the rows that are shown, and keeps a hidden amount out of suggested_cents', () => {
    const [offer] = readCheckoutOffers(offerWithPolicy(policy({})) as never, { suggestionLists: lists([
      { cents: 500, shown: true }, { cents: 1000, shown: false }, { cents: 2500, shown: true },
    ]) });
    expect(offer.price_options[0].voluntary_amount_policy).toEqual({
      allow_custom: true, currency: 'usd', min_cents: 100, suggested_cents: [500, 2500],
    });
  });

  it('refuses a hidden amount outside the policy range, a highlight on a hidden amount, and inline amounts beside a list', () => {
    expect(() => readCheckoutOffers(offerWithPolicy(policy({})) as never, { suggestionLists: lists([{ cents: 50, shown: false }]) }))
      .toThrow(/within the policy range/);
    expect(() => readCheckoutOffers(offerWithPolicy(policy({ highlighted_cents: 1000, highlight_label: 'Most picked' })) as never, { suggestionLists: lists([
      { cents: 500, shown: true }, { cents: 1000, shown: false },
    ]) })).toThrow(/highlighted_cents must match/);
    expect(() => readCheckoutOffers(offerWithPolicy(policy({ suggested_cents: [500] })) as never, { suggestionLists: lists([{ cents: 500, shown: true }]) }))
      .toThrow(/state one/);
  });
});
