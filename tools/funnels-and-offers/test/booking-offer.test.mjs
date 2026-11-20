// An offer whose next step is a booked time carries its booking address on the price option, with no amount. The one
// offer reader keeps that address and the option stays sold (for_sale is not false), so a page can draw it as a card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCheckoutOffers } from '../read-data/read-offers.ts';

const call = {
  kind: 'commercial-offer', id: 'offer:call', label: 'Book a call', summary: 'A call.', sort_order: 40,
  price_options: [{ id: 'price:call:booking', label: 'Book a call', payment_timing: 'booking', booking_url: 'https://example.test/call' }],
};

test('a booking option keeps its booking address and no amount', () => {
  const [offer] = readCheckoutOffers([call]);
  assert.equal(offer.id, 'offer:call');
  assert.deepEqual(offer.price_options, [{
    id: 'price:call:booking', label: 'Book a call', payment_timing: 'booking', booking_url: 'https://example.test/call',
  }]);
});

test('a booking option without an address keeps no booking_url key', () => {
  const [offer] = readCheckoutOffers([{ ...call, price_options: [{ id: 'price:call:booking', label: 'Book a call', payment_timing: 'booking' }] }]);
  assert.equal('booking_url' in offer.price_options[0], false);
});
