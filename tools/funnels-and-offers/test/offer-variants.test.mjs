// The one offer reader resolves a price-test arm (`variant_of`) into the offer it varies, carries what a checkout needs
// (a quantity the buyer picks, the note beside the pay button) and keeps a retired offer (`for_sale: false`) out of
// what is sold while it stays readable for what people already bought.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOfferVariants } from '../read-data/offer-variants.mjs';
import { readCheckoutOffers } from '../read-data/read-offers.ts';

const box = {
  kind: 'commercial-offer', id: 'offer:bread-box', public_offer_id: 'bread-box', label: 'Bread box',
  summary: 'A loaf a week for $40 a month.', checkout_note: 'The first loaf ships on Monday.',
  price_options: [{ id: 'price:bread-box-monthly', label: '$40 a month', amount_cents: 4000, currency: 'usd', payment_timing: 'subscription', interval: 'month',
    trial_days: 7, charges: [{ amount_cents: 200, days_after_signup: 0 }, { amount_cents: 3800, days_after_signup: 7 }], quantity: { minimum: 1 } }],
};
const higher = {
  kind: 'commercial-offer', id: 'offer:bread-box-50', variant_of: 'offer:bread-box', public_offer_id: 'bread-box-50',
  replace_words: { $40: '$50' },
  price_options: [{ id: 'price:bread-box-monthly-50', label: '$50 a month', amount_cents: 5000, currency: 'usd', payment_timing: 'subscription', interval: 'month', quantity: { minimum: 1, maximum: 12 } }],
};
const retired = { kind: 'commercial-offer', id: 'offer:old-box', label: 'Old box', for_sale: false, price_options: [{ id: 'price:old-box', label: '$30', amount_cents: 3000, currency: 'usd', payment_timing: 'one_time' }] };

test('a variant reads as the offer it varies, in its own words and price, with its own identity', () => {
  const [, arm] = resolveOfferVariants([box, higher]);
  assert.equal(arm.id, 'offer:bread-box-50');
  assert.equal(arm.public_offer_id, 'bread-box-50');
  assert.equal(arm.label, 'Bread box');
  assert.equal(arm.summary, 'A loaf a week for $50 a month.');
  assert.equal(arm.checkout_note, 'The first loaf ships on Monday.');
  assert.equal(arm.price_options[0].amount_cents, 5000, 'its own fields replace the inherited ones whole');
  assert.throws(() => resolveOfferVariants([{ id: 'a', variant_of: 'b' }, { id: 'b', variant_of: 'a' }]), /variant of itself/);
  assert.throws(() => resolveOfferVariants([{ id: 'a', variant_of: 'missing' }]), /not an offer row/);
});

test('the reader carries quantity, the checkout note and the split first month, and sells no retired offer', () => {
  const sold = readCheckoutOffers([box, higher, retired]);
  assert.deepEqual(sold.map(offer => offer.id), ['offer:bread-box', 'offer:bread-box-50']);
  const [plan, arm] = sold;
  assert.equal(plan.checkout_note, 'The first loaf ships on Monday.');
  assert.deepEqual(plan.price_options[0].quantity, { minimum: 1 });
  assert.deepEqual(plan.price_options[0].charges, [{ amount_cents: 200, days_after_signup: 0 }, { amount_cents: 3800, days_after_signup: 7 }]);
  assert.deepEqual(arm.price_options[0].quantity, { minimum: 1, maximum: 12 });
  const all = readCheckoutOffers([box, higher, retired], { includeSuperseded: true });
  assert.equal(all.find(offer => offer.id === 'offer:old-box').for_sale, false, 'what was bought stays readable');
});
