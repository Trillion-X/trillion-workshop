import { describe, expect, it } from './expect.mjs';
import { buildCheckoutQuote } from '../read-data/checkout-quote.ts';
import { readCheckoutOffers } from '../../funnels-and-offers/read-data/read-offers.ts';
import { assertPaidAmountMatchesSignedQuote } from '../read-data/verify-paid-amount.ts';

describe('PWYW local chain proof', () => {
  it('preserves policy, validates custom money, signs the quote identity, and verifies readback', () => {
    const [offer] = readCheckoutOffers({
      records: [{
        access_refs: [],
        id: 'offer:proof-contribution',
        kind: 'commercial-offer',
        label: 'Proof contribution',
        post_purchase_route_path: '/support/thank-you',
        price_options: [{
          amount_cents: 1000,
          currency: 'usd',
          id: 'price:proof:one-time',
          label: 'One-time contribution',
          payment_timing: 'one_time',
          voluntary_amount_policy: {
            allow_custom: true,
            currency: 'usd',
            max_cents: 100000,
            min_cents: 100,
            suggested_cents: [500, 1000, 2500],
          },
        }],
      }],
    });
    const quote = buildCheckoutQuote([offer], {
      checkoutAttemptId: 'proof-attempt-1234',
      checkoutStartedAt: '2026-08-21T00:00:00Z',
      consent: { billing: true, legal: true },
      customer: {
        email: 'proof@example.com',
        firstName: 'Proof',
        lastName: 'Patron',
      },
      customerSelectedAmountCents: 1777,
      offerId: offer.id,
      priceOptionId: 'price:proof:one-time',
    });
    const signed = {
      amountCents: Number(quote.validatedAmountCents),
      cadence: quote.cadence,
      currency: quote.currency,
      priceOptionId: quote.priceOptionId,
    };
    assertPaidAmountMatchesSignedQuote(offer, { amountCents: 1777, currency: 'usd' }, signed);
    const proof = {
      accepted: true,
      cadence: signed.cadence,
      currency: signed.currency,
      policy: offer.price_options[0].voluntary_amount_policy,
      priceOptionId: signed.priceOptionId,
      route: offer.post_purchase_route_path,
      validatedAmountCents: signed.amountCents,
    };
    expect(proof).toMatchObject({
      accepted: true,
      cadence: 'one_time',
      currency: 'usd',
      route: '/support/thank-you',
      validatedAmountCents: 1777,
    });
    if (process.env.PWYW_PROOF === '1') {
      console.log(`PWYW_PROOF ${JSON.stringify(proof)}`);
    }
  });
});
