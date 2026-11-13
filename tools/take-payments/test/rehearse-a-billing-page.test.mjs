// A billing page rehearsed in Stripe test mode, with a stand-in Stripe: a live key is refused before anything is built,
// the subscription the schedule starts is the one whose billing page is opened, a test account with no portal
// configuration gets one made, and every address that goes out is the test account's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rehearseABillingPage } from '../do-work/rehearse-a-billing-page.mjs';
import { rehearseABillingPageInTestMode } from '../do-work/take-payments.mjs';

const input = { product_name: 'Sample membership', amount_cents: 1000, return_url: 'https://app.example.com/billing' };

function stripeStandIn({ schedule = { id: 'sub_sched_1', subscription: 'sub_1' }, configurations = [{ id: 'bpc_1', is_default: true, active: true }] } = {}) {
  const sent = [];
  const send = async request => {
    sent.push(request);
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const replies = {
      'POST /v1/customers': { id: 'cus_1' },
      'POST /v1/products': { id: 'prod_1' },
      'POST /v1/prices': { id: 'price_1' },
      'POST /v1/subscription_schedules': schedule,
      'GET /v1/subscriptions': { data: [{ id: 'sub_listed' }] },
      'GET /v1/subscriptions/sub_1': { id: 'sub_1', customer: 'cus_1', default_payment_method: null },
      'GET /v1/subscriptions/sub_listed': { id: 'sub_listed', customer: 'cus_1', default_payment_method: null },
      'GET /v1/billing_portal/configurations': { data: configurations },
      'POST /v1/billing_portal/configurations': { id: 'bpc_made' },
      'POST /v1/billing_portal/sessions': { id: 'bps_1', url: 'https://billing.stripe.com/p/session/test_1' },
    };
    if (!(key in replies)) throw new Error(`unexpected ${key}`);
    return replies[key];
  };
  return { sent, send };
}

test('makes a subscription and opens its billing page with the account\'s own configuration', async () => {
  const { sent, send } = stripeStandIn();
  const answer = await rehearseABillingPage(input, send);
  assert.deepEqual(answer, { subscription_id: 'sub_1', redirect: 'https://billing.stripe.com/p/session/test_1', card: null, customer_id: 'cus_1', schedule_id: 'sub_sched_1', portal_configuration: 'bpc_1' });
  const session = sent.find(request => request.url.endsWith('/billing_portal/sessions'));
  assert.match(session.body, /customer=cus_1/);
  assert.match(session.body, /configuration=bpc_1/);
  assert.ok(sent.every(request => request.method === 'GET' || /\/(customers|products|prices|subscription_schedules|billing_portal\/sessions)$/.test(request.url)), 'only test objects and the one session are made');
});

test('finds the subscription by its customer when the schedule does not name it, and makes a configuration when the account has none', async () => {
  const { sent, send } = stripeStandIn({ schedule: { id: 'sub_sched_1' }, configurations: [] });
  const answer = await rehearseABillingPage(input, send);
  assert.deepEqual([answer.subscription_id, answer.portal_configuration], ['sub_listed', 'bpc_made']);
  assert.ok(sent.some(request => request.method === 'POST' && request.url.endsWith('/billing_portal/configurations')));
});

test('refuses what it cannot rehearse before a request goes out', async () => {
  const { sent, send } = stripeStandIn();
  await assert.rejects(rehearseABillingPage({ ...input, product_name: ' ' }, send), /product name/);
  await assert.rejects(rehearseABillingPage({ ...input, amount_cents: 0 }, send), /amount_cents/);
  await assert.rejects(rehearseABillingPage({ ...input, return_url: 'http://app.example.com' }, send), /return_url must be an https address/);
  assert.deepEqual(sent, []);
});

test('a key that is not a test key is refused before anything is built', async () => {
  const { sent, send } = stripeStandIn();
  await assert.rejects(rehearseABillingPageInTestMode(input, { key: 'sk_live_made_up_not_real', send }), /not a Stripe test key/);
  assert.deepEqual(sent, []);
  const done = await rehearseABillingPageInTestMode(input, { key: 'sk_test_made_up_sample_key', send });
  assert.equal(done.subscription_id, 'sub_1');
});
