// packages/checkout/read-data/price-discovery.test.ts
//
// The controller from the owner's pricing sample ("Variable Speed Controller"):
//   price = start × 2^((sales − loss_weight × losses) / sales_to_double)
// Every assertion is about what a BUYER is offered and what checkout ENFORCES,
// both of which come out of readCheckoutOffers, so they cannot disagree.
import { describe, expect, it } from './expect.mjs';
import { discoveredPriceCents, readCheckoutOffers } from '../../funnels-and-offers/read-data/read-offers.ts';

const offerWith = (discovery: Record<string, unknown>) => ({
  records: [{
    id: 'offer:membership', kind: 'commercial-offer', label: 'Membership',
    price_options: [{
      id: 'price:membership:monthly', label: 'Monthly', amount_cents: 5000, currency: 'usd',
      interval: 'month', payment_timing: 'recurring',
      voluntary_amount_policy: { allow_custom: true, currency: 'usd', price_discovery: discovery },
    }],
  }],
});
const base = { start_cents: 5000, sales_to_double: 1, target_win_rate: 0.05, suggested_multiples: [1, 2, 4] };
const policyOf = (discovery: Record<string, unknown>) => {
  const [offer] = readCheckoutOffers(offerWith(discovery) as never);
  return offer.price_options[0];
};

describe('price discovery', () => {
  it('holds the start price before any sale', () => {
    const option = policyOf({ ...base, sales: 0, reached_price: 0 });
    expect(option.voluntary_amount_policy?.min_cents).toBe(5000);
    expect(option.voluntary_amount_policy?.suggested_cents).toEqual([5000, 10000, 20000]);
    expect(option.amount_cents).toBe(5000);
  });

  it('doubles on every sale when one sale doubles it', () => {
    expect(policyOf({ ...base, sales: 1, reached_price: 1 }).voluntary_amount_policy?.min_cents).toBe(10000);
    expect(policyOf({ ...base, sales: 3, reached_price: 3 }).voluntary_amount_policy?.min_cents).toBe(40000);
    // The option's own amount follows, so a default checkout is never below the minimum.
    expect(policyOf({ ...base, sales: 3, reached_price: 3 }).amount_cents).toBe(40000);
  });

  it('holds still at the target win rate, and falls when people reach the price and do not buy', () => {
    // 1 sale in 20 people who reached the price is exactly 5%: no drift.
    expect(policyOf({ ...base, sales: 1, reached_price: 20 }).voluntary_amount_policy?.min_cents).toBe(5000);
    // 1 sale in 39 (2.6%): 38 losses × 1/19 = 2 sales' worth down, net −1, so it halves.
    expect(policyOf({ ...base, sales: 1, reached_price: 39 }).voluntary_amount_policy?.min_cents).toBe(2500);
  });

  it('matches the sample at q = 80% and five sales to double', () => {
    const sample = { start_cents: 500000, sales_to_double: 5, target_win_rate: 0.8 };
    expect(discoveredPriceCents({ ...sample, sales: 1, reached_price: 1 })).toBe(574300);
    expect(discoveredPriceCents({ ...sample, sales: 5, reached_price: 5 })).toBe(1000000);
    // Exactly 80% wins: four sales and one loss return to the start.
    expect(discoveredPriceCents({ ...sample, sales: 4, reached_price: 5 })).toBe(500000);
  });

  it('never goes below a stated floor, and still doubles above it', () => {
    const patron = { start_cents: 5000, sales_to_double: 1, target_win_rate: 0.05, floor_cents: 5000 };
    expect(discoveredPriceCents({ ...patron, sales: 0, reached_price: 200 })).toBe(5000);
    expect(discoveredPriceCents({ ...patron, sales: 1, reached_price: 1 })).toBe(10000);
    // Without a floor the same rejections pull the price below the start.
    expect(discoveredPriceCents({ ...patron, floor_cents: undefined, sales: 0, reached_price: 19 })).toBe(2500);
  });

  it('anchors known presales and a prior view at a configurable $99 price, then keeps moving', () => {
    const anchored = {
      ...base,
      start_cents: 10000,
      reference_sales: 2,
      reference_nonbuyer_views: 1,
      price_markdown_cents: 100,
    };
    expect(policyOf(anchored).voluntary_amount_policy?.min_cents).toBe(9900);
    expect(policyOf({ ...anchored, sales: 2, reached_price: 3 }).amount_cents).toBe(9900);
    expect(policyOf({ ...anchored, sales: 2, reached_price: 4 }).voluntary_amount_policy?.min_cents).toBe(9500);
    expect(policyOf({ ...anchored, sales: 3, reached_price: 4 }).voluntary_amount_policy?.min_cents).toBe(19900);
    // The anchor is already-observed history; a temporarily unavailable sales
    // feed must not erase those known buyers and fall back to a lower price.
    expect(policyOf({ ...anchored, sales: 0, reached_price: 0 }).voluntary_amount_policy?.min_cents).toBe(9900);
  });

  it('rejects a markdown that consumes the entire reference price', () => {
    expect(() => policyOf({ ...base, price_markdown_cents: 5000 })).toThrow(/below start_cents/);
  });

  it('refuses a policy that states a price AND derives one', () => {
    expect(() => readCheckoutOffers({
      records: [{ ...offerWith({ ...base, sales: 0, reached_price: 0 }).records[0], price_options: [{
        ...offerWith({ ...base, sales: 0, reached_price: 0 }).records[0].price_options[0],
        voluntary_amount_policy: { allow_custom: true, currency: 'usd', min_cents: 5000, price_discovery: { ...base, sales: 0, reached_price: 0 } },
      }] }],
    } as never)).toThrow(/derives min_cents/);
  });
});

const listedOffer = (policy: Record<string, unknown>) => ({
  records: [{
    id: 'offer:membership', kind: 'commercial-offer', label: 'Membership',
    price_options: [{
      id: 'price:membership:monthly', label: 'Monthly', amount_cents: 5000, currency: 'usd',
      interval: 'month', payment_timing: 'recurring', voluntary_amount_policy: policy,
    }],
  }],
});
const multiplesList = 'list:membership-multiples';
const multiplesRows = { list: multiplesList, value_field: 'multiple', shown_field: 'shown' };
const listsWith = (rows: unknown[]) => new Map([[multiplesList, rows]]);
const discovery = { start_cents: 5000, sales_to_double: 1, target_win_rate: 0.05, sales: 0, reached_price: 0 };

describe('price discovery ceiling and fixed price', () => {
  it('caps the discovered price at ceiling_cents, and the option follows the cap', () => {
    const option = policyOf({ ...base, ceiling_cents: 15000, sales: 3, reached_price: 3 });
    expect(option.voluntary_amount_policy?.min_cents).toBe(15000);
    expect(option.amount_cents).toBe(15000);
  });

  it('a floor equal to the ceiling is a fixed price, whatever sales or refusals happen', () => {
    for (const [sales, reached] of [[0, 0], [1, 1], [5, 5], [0, 300]]) {
      const option = policyOf({ ...base, floor_cents: 9900, ceiling_cents: 9900, sales, reached_price: reached });
      expect(option.voluntary_amount_policy?.min_cents).toBe(9900);
      expect(option.amount_cents).toBe(9900);
    }
  });

  it.each([
    [{ ...base, floor_cents: 6000, ceiling_cents: 5000 }, /ceiling_cents must be at least floor_cents/],
    [{ ...base, ceiling_cents: -1 }, /ceiling_cents must be a non-negative safe integer/],
    [{ ...base, ceiling_cents: '5000' }, /ceiling_cents must be a non-negative safe integer/],
    [{ ...base, ceiling_cents: 1.5 }, /ceiling_cents must be a non-negative safe integer/],
  ])('refuses an invalid ceiling: %j', (rule, message) => {
    expect(() => policyOf({ ...rule, sales: 0, reached_price: 0 })).toThrow(message as RegExp);
  });
});

describe('suggested amounts named by a list of rows', () => {
  it('a row with shown false keeps its multiple out of the suggestions, and the rest are offered in order', () => {
    const [offer] = readCheckoutOffers(listedOffer({
      allow_custom: true, currency: 'usd', price_discovery: discovery, suggestion_rows: multiplesRows,
    }) as never, { suggestionLists: listsWith([
      { multiple: 4, shown: true }, { multiple: 2, shown: false }, { multiple: 1, shown: true },
    ]) });
    expect(offer.price_options[0].voluntary_amount_policy?.suggested_cents).toEqual([5000, 20000]);
  });

  it('with every suggestion off, the buyer still sees the custom amount when allow_custom is on', () => {
    const [offer] = readCheckoutOffers(listedOffer({
      allow_custom: true, currency: 'usd', price_discovery: discovery, suggestion_rows: multiplesRows,
    }) as never, { suggestionLists: listsWith([{ multiple: 1, shown: false }]) });
    expect(offer.price_options[0].voluntary_amount_policy?.suggested_cents).toEqual([]);
    expect(offer.price_options[0].voluntary_amount_policy?.allow_custom).toBe(true);
  });

  it('refuses a policy with every suggestion off and no custom amount', () => {
    expect(() => readCheckoutOffers(listedOffer({
      allow_custom: false, currency: 'usd', price_discovery: discovery, suggestion_rows: multiplesRows,
    }) as never, { suggestionLists: listsWith([{ multiple: 1, shown: false }]) })).toThrow(/selectable amount/);
  });

  it('refuses a list the reader was not given, a row without a shown switch, and inline suggestions beside a list', () => {
    expect(() => readCheckoutOffers(listedOffer({
      allow_custom: true, currency: 'usd', price_discovery: discovery, suggestion_rows: multiplesRows,
    }) as never)).toThrow(/were not read/);
    expect(() => readCheckoutOffers(listedOffer({
      allow_custom: true, currency: 'usd', price_discovery: discovery, suggestion_rows: multiplesRows,
    }) as never, { suggestionLists: listsWith([{ multiple: 1 }]) })).toThrow(/shown/);
    expect(() => readCheckoutOffers(listedOffer({
      allow_custom: true, currency: 'usd', price_discovery: { ...discovery, suggested_multiples: [1] }, suggestion_rows: multiplesRows,
    }) as never, { suggestionLists: listsWith([{ multiple: 1, shown: true }]) })).toThrow(/state one/);
  });
});
