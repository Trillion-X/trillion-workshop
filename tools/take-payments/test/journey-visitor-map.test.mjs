// tools/take-payments/test/journey-visitor-map.test.mjs
// A completed checkout carries the journey visitor from its metadata onto the payment event's attributes, so the journey
// kit can join the sale to the visitor who paid (journey-kept-rows reads attributes.journey_visitor). The map row is the
// one place that names it: the live webhook and the catch-up path read the same webhook-event-map.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mapStripeWebhookEvent, paymentEventNamedBy } from '../do-work/map-webhook-event.mjs';

const eventMap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../read-data/webhook-event-map.json'), 'utf8'));

const completed = (type, metadata) => ({
  id: 'evt_1',
  type,
  created: 1_700_000_000,
  data: { object: { id: 'cs_1', amount_total: 4900, currency: 'usd', payment_status: 'paid', metadata, customer_details: { email: 'a@example.com' } } },
});

for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) {
  test(`${type} keeps metadata.journey_visitor as the payment event's journey_visitor attribute`, () => {
    const mapped = mapStripeWebhookEvent(completed(type, { offer_id: 'course', journey_visitor: 'visitor-one-1' }), eventMap);
    assert.equal(mapped.attributes.journey_visitor, 'visitor-one-1');
    assert.equal(paymentEventNamedBy(mapped).attributes.journey_visitor, 'visitor-one-1');
  });

  test(`${type} without a journey visitor keeps no journey_visitor attribute`, () => {
    const mapped = mapStripeWebhookEvent(completed(type, { offer_id: 'course' }), eventMap);
    assert.equal(mapped.attributes.journey_visitor, undefined);
  });
}
