// tools/take-payments/test/catch-up-journey-visitor.test.mjs
// The catch-up path (listCompletedCheckoutsAsPaymentEvents) keeps a completed checkout's journey_visitor on its payment
// event, the same as the live webhook does, so a sale read back later still joins to the visitor who paid. Synthetic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listCompletedCheckoutsAsPaymentEvents } from '../do-work/take-payments.mjs';

const session = (id, metadata) => ({
  id, object: 'checkout.session', status: 'complete', created: 1790000000, amount_total: 4900, currency: 'usd', subscription: null,
  customer_details: { email: `${id}@example.test` }, metadata: { offer_id: 'offer:course', ...metadata },
});
const contextOf = sessions => ({ send: async () => ({ data: sessions, has_more: false }) });

test('a completed checkout with metadata.journey_visitor keeps it on its payment event attributes', async () => {
  const answer = await listCompletedCheckoutsAsPaymentEvents({ created_after_unix: 0 }, contextOf([session('cs_visit', { journey_visitor: 'visitor-one-1' })]));
  assert.equal(answer.events.length, 1);
  assert.equal(answer.events[0].attributes.journey_visitor, 'visitor-one-1');
});

test('a completed checkout without a journey visitor keeps no journey_visitor attribute', async () => {
  const answer = await listCompletedCheckoutsAsPaymentEvents({ created_after_unix: 0 }, contextOf([session('cs_plain', {})]));
  assert.equal(answer.events[0].attributes.journey_visitor, undefined);
});
