// A price per person, declared as data: one person included in amount_cents and each more person adding the same
// unit_cents. The total must be the price times the people, never a first person free: 1, 50 and 100 people at
// 29900 cents a person cost 29900, 1495000 and 2990000. Read through the one offer reader, as take-payments reads it.
import { describe, expect, it } from './expect.mjs';
import { readCheckoutOffers } from '../../funnels-and-offers/read-data/read-offers.ts';
import { curveAmountCents, paidMatchesCurve } from '../read-data/unit-price-curve.ts';
import { checkWhatWasPaid } from '../do-work/take-payments.mjs';

const offers = [{ kind: 'commercial-offer', id: 'offer:per-person', label: 'Per person', price_options: [
  { id: 'price:per-person-monthly', label: 'per person a month', currency: 'usd', payment_timing: 'subscription', interval: 'month',
    amount_cents: 29900, included_units: 1, unit_price_curve: [{ up_to_units: null, unit_cents: 29900 }], trial_days: 7 },
] }];

describe('a price per person', () => {
  it('costs the price times the people for 1, 50 and 100 people', () => {
    const option = readCheckoutOffers(offers)[0].price_options[0];
    expect(curveAmountCents(option, 1)).toBe(29900n);
    expect(curveAmountCents(option, 50)).toBe(1495000n);
    expect(curveAmountCents(option, 100)).toBe(2990000n);
    for (const people of [1, 2, 49, 50, 100]) expect(curveAmountCents(option, people)).toBe(29900n * BigInt(people));
  });

  it('accepts exactly those totals as paid, and not one person short', async () => {
    const option = readCheckoutOffers(offers)[0].price_options[0];
    for (const cents of [29900, 1495000, 2990000]) expect(paidMatchesCurve(option, cents)).toBe(true);
    expect(paidMatchesCurve(option, 1495000 - 29900 + 1)).toBe(false);
    expect(await checkWhatWasPaid({ offer_id: 'offer:per-person', offers, paid: { amountCents: 1495000, currency: 'usd' } }, {})).toMatchObject({ matches: true });
    expect(await checkWhatWasPaid({ offer_id: 'offer:per-person', offers, paid: { amountCents: 14950, currency: 'usd' } }, {})).toMatchObject({ matches: false });
  });
});
