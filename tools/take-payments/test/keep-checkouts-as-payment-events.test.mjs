// tools/take-payments/test/keep-checkouts-as-payment-events.test.mjs
// A completed checkout becomes one payment event in the answer (nothing is written: the tool opens no records door), and
// paid-access then holds the buyer's access by the email on the purchase: a purchase no webhook reported still gives access.
// Synthetic buyers and offers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listCompletedCheckoutsAsPaymentEvents } from '../do-work/take-payments.mjs';
import { heldAccess } from '../../paid-access/read-data/who-holds-access.mjs';

const session = (id, fields = {}) => ({
  id, object: 'checkout.session', status: 'complete', created: 1790000000, amount_total: 10000, currency: 'usd', subscription: null,
  customer_details: { email: `${id}@example.test` }, metadata: { offer_id: 'offer:presale', price_option_id: 'price:presale:once' }, ...fields,
});
const offers = [{ kind: 'commercial-offer', id: 'offer:presale', label: 'Presale', access_refs: ['access:coach'], price_options: [{ id: 'price:presale:once', label: 'Once', amount_cents: 10000, currency: 'usd', payment_timing: 'one_time' }] }];

const contextOf = sessions => ({ send: async () => ({ data: sessions, has_more: false }) });
const run = (sessions, input = {}) => listCompletedCheckoutsAsPaymentEvents({ created_after_unix: 0, ...input }, contextOf(sessions));

test('each completed checkout with a buyer email and an offer is an event in the answer, the same event on every run', async () => {
  const sessions = [session('cs_dean'), session('cs_julien')];
  const first = await run(sessions);
  assert.equal(first.events.length, 2);
  assert.deepEqual(first.events.map(event => event.id).sort(), ['payment-event:checkout:cs_dean', 'payment-event:checkout:cs_julien']);
  assert.deepEqual((await run(sessions)).events, first.events);
  assert.equal(first.complete, true);
});

test('a checkout with no buyer email or no offer is left out and counted', async () => {
  const answer = await run([session('cs_ok'), session('cs_noemail', { customer_details: {} }), session('cs_nooffer', { metadata: {} })]);
  assert.deepEqual([answer.events.length, answer.left_out.no_buyer_email, answer.left_out.no_offer], [1, 1, 1]);
});

test('paid-access then holds the buyer\'s access by the email on the purchase, and a stranger holds none', async () => {
  const { events: paymentEvents } = await run([session('cs_dean'), session('cs_free', { amount_total: 0, metadata: { offer_id: 'offer:presale' } })]);
  const held = who => heldAccess({ subject: who, nowMs: Date.now(), paymentEvents, offers, grants: [], emailVerified: true }).held_access_refs;
  assert.ok(held('cs_dean@example.test').includes('access:coach'));
  assert.ok(!held('stranger@example.test').includes('access:coach'));
});

test('each event carries its offer\'s pursuits when the request carries the offers, and none when it does not', async () => {
  const named = offers.map(offer => ({ ...offer, pursuit_ids: ['pursuit:bakery'] }));
  assert.equal((await run([session('cs_dean')], { offers })).events[0].pursuit_ids, undefined);
  assert.deepEqual((await run([session('cs_dean')], { offers: named })).events[0].pursuit_ids, ['pursuit:bakery']);
});

test('a sale made under an offer\'s earlier id takes that offer\'s pursuits', async () => {
  const renamed = [{ ...offers[0], id: 'offer:box', earlier_ids: ['offer:presale'], pursuit_ids: ['pursuit:bakery'] }];
  assert.deepEqual((await run([session('cs_old')], { offers: renamed })).events[0].pursuit_ids, ['pursuit:bakery']);
});

test('the tool opens no records door: a context holding none runs, and nothing is written anywhere', async () => {
  const context = contextOf([session('cs_dean')]);
  assert.equal('door' in context, false);
  assert.equal((await listCompletedCheckoutsAsPaymentEvents({ created_after_unix: 0 }, context)).events.length, 1);
});
