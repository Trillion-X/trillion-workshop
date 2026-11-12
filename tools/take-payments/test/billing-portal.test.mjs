// tools/take-payments/test/billing-portal.test.mjs
//
// The billing page of one purchase, with a stand-in Stripe: the portal session is opened for the customer that bills
// the subscription, the card is the one that pays it (brand, last four, expiry only), nothing but reads and that one
// session is sent, and every refusal happens before a request could change anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBillingPage } from '../do-work/billing-portal.mjs';

const subscription = {
  id: 'sub_sample0001',
  object: 'subscription',
  customer: 'cus_sample0001',
  default_payment_method: {
    id: 'pm_sample0001',
    type: 'card',
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, fingerprint: 'must-not-leak' },
  },
};

function stripeStandIn(overrides = {}) {
  const sent = [];
  const replies = {
    'GET /v1/subscriptions/sub_sample0001': subscription,
    'GET /v1/billing_portal/configurations': { data: [{ id: 'bpc_other', is_default: false, active: true }, { id: 'bpc_default', is_default: true, active: true }] },
    'POST /v1/billing_portal/sessions': { id: 'bps_sample0001', url: 'https://billing.stripe.com/p/session/test_sample0001' },
    ...overrides,
  };
  const send = async request => {
    sent.push(request);
    const key = `${request.method} ${new URL(request.url).pathname}`;
    if (!(key in replies)) throw new Error(`unexpected ${key}`);
    return replies[key];
  };
  return { sent, send };
}

const input = { subscription_id: 'sub_sample0001', return_url: 'https://app.example.com/billing' };

test('opens the portal for the subscription customer and shows the paying card without its secrets', async () => {
  const { sent, send } = stripeStandIn();
  const result = await openBillingPage(input, { send });
  assert.deepEqual(result, {
    subscription_id: 'sub_sample0001',
    redirect: 'https://billing.stripe.com/p/session/test_sample0001',
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
  });
  const session = sent.find(request => request.method === 'POST');
  assert.match(session.body, /customer=cus_sample0001/);
  assert.match(session.body, /configuration=bpc_default/);
  assert.match(session.body, /return_url=https%3A%2F%2Fapp\.example\.com%2Fbilling/);
  assert.doesNotMatch(JSON.stringify(result), /fingerprint|must-not-leak|pm_sample/);
});

test('reads the subscription with its default payment method expanded', async () => {
  const { sent, send } = stripeStandIn();
  await openBillingPage(input, { send });
  const read = sent.find(request => request.method === 'GET' && request.url.includes('/v1/subscriptions/'));
  assert.match(read.url, /expand%5B0%5D=default_payment_method|expand\[0\]=default_payment_method/);
});

test('uses the configuration the caller names without looking any up', async () => {
  const { sent, send } = stripeStandIn();
  await openBillingPage({ ...input, configuration: 'bpc_named' }, { send });
  assert.equal(sent.some(request => request.url.includes('/billing_portal/configurations')), false);
  assert.match(sent.find(request => request.method === 'POST').body, /configuration=bpc_named/);
});

test('answers no card when the subscription has no card on file', async () => {
  const { send } = stripeStandIn({ 'GET /v1/subscriptions/sub_sample0001': { ...subscription, default_payment_method: null } });
  const result = await openBillingPage(input, { send });
  assert.equal(result.card, null);
  assert.equal(result.redirect, 'https://billing.stripe.com/p/session/test_sample0001');
});

test('refuses a subscription id that is not a sub_ id before any request is sent', async () => {
  const { sent, send } = stripeStandIn();
  await assert.rejects(openBillingPage({ ...input, subscription_id: 'cus_sample0001' }, { send }), /subscription_id/);
  assert.equal(sent.length, 0);
});

test('refuses a return address that is not https before any request is sent', async () => {
  const { sent, send } = stripeStandIn();
  await assert.rejects(openBillingPage({ ...input, return_url: 'http://app.example.com/billing' }, { send }), /return_url/);
  assert.equal(sent.length, 0);
});

test('refuses when the Stripe account has no billing portal configuration', async () => {
  const { send } = stripeStandIn({ 'GET /v1/billing_portal/configurations': { data: [] } });
  await assert.rejects(openBillingPage(input, { send }), /billing portal configuration/);
});

test('refuses a session address that is not on the billing host', async () => {
  const { send } = stripeStandIn({ 'POST /v1/billing_portal/sessions': { url: 'https://evil.example.com/billing' } });
  await assert.rejects(openBillingPage(input, { send }), /billing-session address/);
});

test('refuses a subscription the provider does not tie to a customer', async () => {
  const { send } = stripeStandIn({ 'GET /v1/subscriptions/sub_sample0001': { id: 'sub_sample0001', customer: null } });
  await assert.rejects(openBillingPage(input, { send }), /billing profile/);
});
