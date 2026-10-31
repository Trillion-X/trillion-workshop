import { describe, expect, it } from './expect.mjs';
import type { CheckoutMaterialRequest } from '../read-data/checkout-contract.ts';
import { buildCheckoutMaterialQuote } from '../read-data/checkout-quote.ts';
import { readCheckoutOffers } from '../../funnels-and-offers/read-data/read-offers.ts';
import { paidAmountMatchesSignedQuote } from '../read-data/verify-paid-amount.ts';

const PLATFORM_OFFER_RECORD = {
  kind: 'commercial-offer',
  id: 'offer:bakery-platform',
  label: 'Bakery platform',
  summary: 'Platform pricing.',
  access_refs: ['product-access:bakery-platform'],
  price_options: [{
    id: 'price:bakery-platform:monthly',
    label: '$30/month base',
    amount_cents: 3_000,
    currency: 'usd',
    interval: 'month',
    payment_timing: 'subscription',
    charge_dimensions: [
      {
        id: 'oven_count',
        input_kind: 'scalar',
        label: 'Ovens',
        metric: 'licensed_ovens',
        included_units: 5,
        unit_price_curve: [{ up_to_units: null, unit_cents: 3_000 }],
      },
      {
        id: 'active_seats_per_oven',
        input_kind: 'per_scope',
        label: 'Active seats per oven',
        metric: 'active_seats',
        included_units: 100,
        scope_dimension_id: 'oven_count',
        unit_price_curve: [
          { up_to_units: 1_000, unit_cents: 25 },
          { up_to_units: 100_000, unit_cents: 10 },
          { up_to_units: 1_000_000, unit_cents: 5 },
          { up_to_units: null, unit_cents: 1 },
        ],
      },
    ],
  }],
};

const [PLATFORM_OFFER] = readCheckoutOffers({ records: [PLATFORM_OFFER_RECORD] });
const baseInput: CheckoutMaterialRequest = {
  checkoutAttemptId: 'attempt-pricing-v2-0001',
  checkoutStartedAt: '2026-08-23T00:00:00Z',
  offerId: PLATFORM_OFFER.id,
  priceOptionId: PLATFORM_OFFER.price_options[0].id,
};

describe('commercial-offer charge_dimensions', () => {
  it('rejects malformed external input before evaluating any charge', () => {
    for (const chargeDimensions of [{}, [null], [{ dimensionId: 'active_seats_per_oven', scopedUnits: {} }]]) {
      expect(() => buildCheckoutMaterialQuote([PLATFORM_OFFER], {
        ...baseInput, chargeDimensions: chargeDimensions as never,
      })).toThrow(/array|object/);
    }
  });

  it('requires the exact signed amount when completing a dimension-priced payment', () => {
    const quote = buildCheckoutMaterialQuote([PLATFORM_OFFER], {
      ...baseInput, chargeDimensions: [{ dimensionId: 'oven_count', units: 6 }],
    });
    const signed = { amountCents: Number(quote.recurringAmountCents), currency: quote.currency,
      cadence: quote.cadence, priceOptionId: quote.priceOptionId };
    expect(paidAmountMatchesSignedQuote(PLATFORM_OFFER, signed, signed)).toBe(true);
    expect(paidAmountMatchesSignedQuote(PLATFORM_OFFER, { ...signed, amountCents: signed.amountCents - 1 }, signed)).toBe(false);
  });

  it('parses the generic scalar + per-scope schema from DATA', () => {
    expect(PLATFORM_OFFER.price_options[0].charge_dimensions).toEqual(
      PLATFORM_OFFER_RECORD.price_options[0].charge_dimensions,
    );
  });

  it('rejects incomplete curves and ambiguous legacy metering DATA', () => {
    const withoutUnboundedBand = structuredClone(PLATFORM_OFFER_RECORD);
    withoutUnboundedBand.price_options[0].charge_dimensions[1].unit_price_curve = [
      { up_to_units: 1_000, unit_cents: 25 },
    ];
    expect(() => readCheckoutOffers({ records: [withoutUnboundedBand] }))
      .toThrow(/final unbounded curve band/);

    const mixedMetering = structuredClone(PLATFORM_OFFER_RECORD);
    Object.assign(mixedMetering.price_options[0], { included_units: 100 });
    expect(() => readCheckoutOffers({ records: [mixedMetering] }))
      .toThrow(/cannot combine charge_dimensions/);
  });

  it('adds app-count overage and applies the original seat curve independently per app', () => {
    const quote = buildCheckoutMaterialQuote([PLATFORM_OFFER], {
      ...baseInput,
      chargeDimensions: [
        { dimensionId: 'oven_count', units: 6 },
        {
          dimensionId: 'active_seats_per_oven',
          scopedUnits: [
            { scopeId: 'app-a', units: 100 },
            { scopeId: 'app-b', units: 1_001 },
          ],
        },
      ],
    });
    // $30 base + $30 sixth app + (900 × 25¢) + (1 × 10¢).
    expect(quote.recurringAmountCents).toBe(28_510n);
    expect(quote.chargeDimensions?.map((row) => row.amountCents)).toEqual([3_000n, 22_510n]);
  });

  it('does not collapse per-app seats into one aggregate count', () => {
    const perApp = buildCheckoutMaterialQuote([PLATFORM_OFFER], {
      ...baseInput,
      chargeDimensions: [
        { dimensionId: 'oven_count', units: 5 },
        {
          dimensionId: 'active_seats_per_oven',
          scopedUnits: [
            { scopeId: 'app-a', units: 1_001 },
            { scopeId: 'app-b', units: 1_001 },
          ],
        },
      ],
    });
    const incorrectlyAggregated = buildCheckoutMaterialQuote([PLATFORM_OFFER], {
      ...baseInput,
      chargeDimensions: [
        { dimensionId: 'oven_count', units: 5 },
        {
          dimensionId: 'active_seats_per_oven',
          scopedUnits: [{ scopeId: 'app-a', units: 2_002 }],
        },
      ],
    });
    expect(perApp.recurringAmountCents).toBe(48_020n);
    expect(incorrectlyAggregated.recurringAmountCents).toBe(35_520n);
  });

  it('fails closed on unknown dimensions, duplicate scopes, excess scope cardinality, or legacy unitCount mixing', () => {
    expect(() => buildCheckoutMaterialQuote([PLATFORM_OFFER], {
      ...baseInput,
      chargeDimensions: [{ dimensionId: 'unknown', units: 1 }],
    })).toThrow(/Unknown charge dimension/);
    expect(() => buildCheckoutMaterialQuote([PLATFORM_OFFER], {
      ...baseInput,
      chargeDimensions: [
        { dimensionId: 'oven_count', units: 2 },
        { dimensionId: 'active_seats_per_oven', scopedUnits: [
          { scopeId: 'same', units: 100 },
          { scopeId: 'same', units: 100 },
        ] },
      ],
    })).toThrow(/unique scopeId/);
    expect(() => buildCheckoutMaterialQuote([PLATFORM_OFFER], {
      ...baseInput,
      chargeDimensions: [
        { dimensionId: 'oven_count', units: 1 },
        { dimensionId: 'active_seats_per_oven', scopedUnits: [
          { scopeId: 'app-a', units: 100 },
          { scopeId: 'app-b', units: 100 },
        ] },
      ],
    })).toThrow(/more scoped items/);
    expect(() => buildCheckoutMaterialQuote([PLATFORM_OFFER], {
      ...baseInput,
      chargeDimensions: [{ dimensionId: 'oven_count', units: 5 }],
      unitCount: 5,
    })).toThrow(/cannot also receive legacy unitCount/);
  });

  it('leaves the legacy single-unit curve unchanged', () => {
    const legacy = {
      ...PLATFORM_OFFER,
      id: 'offer:legacy',
      price_options: [{
        amount_cents: 20_000,
        additional_unit_amount_cents: 25,
        currency: 'usd',
        id: 'price:legacy',
        included_units: 100,
        label: 'Legacy',
      }],
    };
    const quote = buildCheckoutMaterialQuote([legacy], {
      ...baseInput,
      offerId: legacy.id,
      priceOptionId: 'price:legacy',
      unitCount: 200,
    });
    expect(quote.recurringAmountCents).toBe(22_500n);
    expect(quote.chargeDimensions).toBeUndefined();
  });
});
