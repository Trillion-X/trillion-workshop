// tools/take-payments/test/keep-checkouts-as-payment-events.test.mjs
// A completed checkout becomes one payment-event record, once, and paid-access then holds the buyer's access by the
// email on the purchase: a purchase no webhook reported still gives access. Synthetic buyers and offers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepCompletedCheckoutsAsPaymentEvents } from '../do-work/take-payments.mjs';
import { heldAccess } from '../../paid-access/read-data/who-holds-access.mjs';

const session = (id, fields = {}) => ({
  id, object: 'checkout.session', status: 'complete', created: 1790000000, amount_total: 10000, currency: 'usd', subscription: null,
  customer_details: { email: `${id}@example.test` }, metadata: { offer_id: 'offer:presale', price_option_id: 'price:presale:once' }, ...fields,
});
const offers = [{ kind: 'commercial-offer', id: 'offer:presale', label: 'Presale', access_refs: ['access:coach'], price_options: [{ id: 'price:presale:once', label: 'Once', amount_cents: 10000, currency: 'usd', payment_timing: 'one_time' }] }];

function world(sessions) {
  const kept = new Map();
  const door = {
    async read(type, id) { return kept.get(`${type}\n${id}`) ?? null; },
    async write(batch) { for (const record of batch) kept.set(`${record.type}\n${record.id}`, record.value); },
  };
  const send = async () => ({ data: sessions, has_more: false });
  return { kept, context: { door, send } };
}

test('each completed checkout with a buyer email and an offer is kept once, and a second run writes nothing', async () => {
  const { kept, context } = world([session('cs_dean'), session('cs_julien')]);
  const first = await keepCompletedCheckoutsAsPaymentEvents({ created_after_unix: 0 }, context);
  assert.deepEqual([first.written, first.already], [2, 0]);
  const again = await keepCompletedCheckoutsAsPaymentEvents({ created_after_unix: 0 }, context);
  assert.deepEqual([again.written, again.already], [0, 2]);
  assert.equal(kept.size, 2);
});

test('a checkout with no buyer email or no offer is left out and counted', async () => {
  const { kept, context } = world([session('cs_ok'), session('cs_noemail', { customer_details: {} }), session('cs_nooffer', { metadata: {} })]);
  const answer = await keepCompletedCheckoutsAsPaymentEvents({ created_after_unix: 0 }, context);
  assert.deepEqual([answer.written, answer.left_out.no_buyer_email, answer.left_out.no_offer], [1, 1, 1]);
  assert.equal(kept.size, 1);
});

test('paid-access then holds the buyer\'s access by the email on the purchase, and a stranger holds none', async () => {
  const { kept, context } = world([session('cs_dean'), session('cs_free', { amount_total: 0, metadata: { offer_id: 'offer:presale' } })]);
  await keepCompletedCheckoutsAsPaymentEvents({ created_after_unix: 0 }, context);
  const paymentEvents = [...kept.values()];
  const held = who => heldAccess({ subject: who, nowMs: Date.now(), paymentEvents, offers, grants: [] }).held_access_refs;
  assert.ok(held('cs_dean@example.test').includes('access:coach'));
  assert.ok(!held('stranger@example.test').includes('access:coach'));
});
