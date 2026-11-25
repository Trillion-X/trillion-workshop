// A listed offer's next step is read from its own price option: a voluntary amount, a fixed checkout or a booking address.
// Anything the card does not prove (another offer's card, a bad address, an amount outside its own range) is no next step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beforeBookingHrefOf, offerCardsOfThisPage, readOfferNextStep, parsePatronAmount } from './program-pricing-policy.ts';

const policy = { currency: 'usd', min_cents: 9900, max_cents: 99999999, allow_free: false, allow_custom: true, suggested_cents: [9900, 20000] };

test('a voluntary price option reads as the amount the buyer picks, within its own range', () => {
  const step = readOfferNextStep({ offer_id: 'offer:m', price_option_id: 'price:m', policy }, 'offer:m');
  assert.equal(step?.kind, 'voluntary');
  assert.equal(step?.policy.minCents, 9900);
  assert.deepEqual(step?.policy.suggestedCents, [9900, 20000]);
});

test('a fixed price option reads as a checkout at its amount', () => {
  assert.deepEqual(readOfferNextStep({ offer_id: 'offer:p', price_option_id: 'price:p', currency: 'usd', amount_cents: 10000 }, 'offer:p'),
    { kind: 'checkout', offerId: 'offer:p', priceOptionId: 'price:p', amountCents: 10000, currency: 'usd' });
});

test('a booking price option reads as its booking address', () => {
  assert.deepEqual(readOfferNextStep({ offer_id: 'offer:c', price_option_id: 'price:c', booking_url: 'https://example.test/call' }, 'offer:c'),
    { kind: 'booking', offerId: 'offer:c', priceOptionId: 'price:c', bookingUrl: 'https://example.test/call' });
});

test('a card for another offer, a non-https booking address, or no price is no next step', () => {
  assert.equal(readOfferNextStep({ offer_id: 'offer:other', price_option_id: 'p', amount_cents: 100, currency: 'usd' }, 'offer:m'), null);
  assert.equal(readOfferNextStep({ offer_id: 'offer:c', price_option_id: 'p', booking_url: 'http://example.test' }, 'offer:c'), null);
  assert.equal(readOfferNextStep({ offer_id: 'offer:c', price_option_id: 'p' }, 'offer:c'), null);
  assert.equal(readOfferNextStep(undefined, 'offer:c'), null);
});

test('a voluntary policy whose suggested amount sits below its minimum is refused', () => {
  assert.equal(readOfferNextStep({ offer_id: 'o', price_option_id: 'p', policy: { ...policy, suggested_cents: [100] } }, 'o'), null);
});

test('the amount the buyer types is refused below the minimum and above the maximum', () => {
  assert.equal(parsePatronAmount('50', 9900, null).kind, 'below-min');
  assert.equal(parsePatronAmount('120.5', 9900, 100000).amountCents, 12050);
  assert.equal(parsePatronAmount('5000', 9900, 100000).kind, 'above-max');
});

test('a booking card with no before-booking template in DATA keeps its bare link (no before-booking address)', () => {
  assert.equal(beforeBookingHrefOf(undefined, 'offer:c'), null);
  assert.equal(beforeBookingHrefOf('', 'offer:c'), null);
  assert.equal(beforeBookingHrefOf(42, 'offer:c'), null);
});

test('a before-booking template takes the offer id, encoded, in place of {offer_id}', () => {
  assert.equal(beforeBookingHrefOf('/before-booking/{offer_id}', 'offer:call-booking'), '/before-booking/offer%3Acall-booking');
});

test('a price section reads the host cards when set, else the cards the page was drawn with, else none', () => {
  const host = { 'offer:m': { offer_id: 'offer:m' } };
  const drawn = { 'offer:m': { offer_id: 'offer:m', amount_cents: 9900 } };
  assert.equal(offerCardsOfThisPage(host, drawn), host);
  assert.equal(offerCardsOfThisPage(undefined, drawn), drawn);
  assert.deepEqual(offerCardsOfThisPage(undefined, undefined), {});
  assert.deepEqual(offerCardsOfThisPage(undefined, [1]), {});
  assert.deepEqual(offerCardsOfThisPage(undefined, 'x'), {});
});
