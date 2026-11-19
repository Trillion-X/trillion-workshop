// tools/take-payments/test/billing-portal.test.mjs
//
// The billing page of one purchase, with a stand-in Stripe: the portal session is opened for the customer that bills
// the subscription, on the flow the buyer picked (card, plan or cancel deep links), the card is the one that pays it
// (brand, last four, expiry only), the purchase as the buyer sees it (plan, renewal, receipts), nothing but reads and
// that one session is sent, and every refusal happens before a request could change anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBillingPage, readBillingPage } from '../do-work/billing-portal.mjs';

const subscription = {
  id: 'sub_sample0001',
  object: 'subscription',
  customer: { id: 'cus_sample0001', object: 'customer', email: 'buyer@example.com' },
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
    'GET /v1/invoices': { data: [] },
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

const input = { subscription_id: 'sub_sample0001', return_url: 'https://app.example.com/billing', subject_email: 'buyer@example.com' };

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
  const { sent, send } = stripeStandIn({ 'GET /v1/subscriptions/sub_sample0001': { id: 'sub_sample0001', customer: null } });
  await assert.rejects(openBillingPage(input, { send }), /signed-in buyer/);
  assert.equal(sent.some(request => request.method === 'POST'), false);
});

test('a purchase that belongs to someone else is refused: no portal session, and no purchase data returned', async () => {
  const { sent, send } = stripeStandIn();
  await assert.rejects(openBillingPage({ ...input, subject_email: 'someone-else@example.com' }, { send }), error => {
    assert.match(error.message, /not one of the signed-in buyer/);
    assert.doesNotMatch(error.message, /buyer@example\.com|someone-else|cus_|pm_|sub_/);
    return true;
  });
  assert.deepEqual(sent.map(request => request.method), ['GET'], 'only the purchase was read; no session, no configuration');
});

test('a purchase read for someone else returns nothing and reads no invoices', async () => {
  const { sent, send } = stripeStandIn();
  await assert.rejects(readBillingPage({ subscription_id: 'sub_sample0001', subject_email: 'someone-else@example.com' }, { send }), /not one of the signed-in buyer/);
  assert.deepEqual(sent.map(request => request.url.split('?')[0]), ['https://api.stripe.com/v1/subscriptions/sub_sample0001'], 'no invoices read');
});

test('a purchase whose customer is not expanded to an email is refused, not guessed', async () => {
  const { send } = stripeStandIn({ 'GET /v1/subscriptions/sub_sample0001': { ...subscription, customer: 'cus_sample0001' } });
  await assert.rejects(readBillingPage({ subscription_id: 'sub_sample0001', subject_email: 'buyer@example.com' }, { send }), /signed-in buyer/);
});

test('a missing or malformed subject is refused before any request is sent', async () => {
  for (const subject_email of [undefined, '', '   ', 'not-an-email', 42]) {
    const { sent, send } = stripeStandIn();
    await assert.rejects(openBillingPage({ ...input, subject_email }, { send }), /subject_email/);
    await assert.rejects(readBillingPage({ subscription_id: 'sub_sample0001', subject_email }, { send }), /subject_email/);
    assert.equal(sent.length, 0);
  }
});

test('the buyer’s own purchase is allowed whatever the case of the email', async () => {
  const { send } = stripeStandIn();
  const result = await openBillingPage({ ...input, subject_email: ' Buyer@Example.COM ' }, { send });
  assert.equal(result.redirect, 'https://billing.stripe.com/p/session/test_sample0001');
  const page = await readBillingPage({ subscription_id: 'sub_sample0001', subject_email: 'BUYER@example.com' }, stripeStandIn({ 'GET /v1/subscriptions/sub_sample0001': flowSubscription }));
  assert.equal(page.subscription_id, 'sub_sample0001');
});

const flowSubscription = {
  ...subscription,
  status: 'active',
  cancel_at_period_end: false,
  items: { data: [{ quantity: 2, current_period_end: 1798000000, price: { unit_amount: 1200, currency: 'usd', recurring: { interval: 'month' }, product: { id: 'prod_sample0001', name: 'Bread box' } } }] },
};

test('a flow opens the portal on that one Stripe deep link for the subscription', async () => {
  const { sent, send } = stripeStandIn();
  await openBillingPage({ ...input, flow: 'subscription_cancel' }, { send });
  assert.equal(decodeURIComponent(sent.find(request => request.method === 'POST').body).includes('flow_data[type]=subscription_cancel&flow_data[subscription_cancel][subscription]=sub_sample0001'), true);
  const plan = stripeStandIn();
  await openBillingPage({ ...input, flow: 'subscription_update' }, { send: plan.send });
  assert.match(decodeURIComponent(plan.sent.find(request => request.method === 'POST').body), /flow_data\[subscription_update\]\[subscription\]=sub_sample0001/);
});

test('the card flow deep-links to the payment method with no subscription object, and no flow means the page itself', async () => {
  const card = stripeStandIn();
  await openBillingPage({ ...input, flow: 'payment_method_update' }, { send: card.send });
  const cardBody = decodeURIComponent(card.sent.find(request => request.method === 'POST').body);
  assert.match(cardBody, /flow_data\[type\]=payment_method_update/);
  assert.doesNotMatch(cardBody, /flow_data\[payment_method_update\]/);
  const page = stripeStandIn();
  await openBillingPage(input, { send: page.send });
  assert.doesNotMatch(decodeURIComponent(page.sent.find(request => request.method === 'POST').body), /flow_data/);
});

test('refuses a flow that is not one of the billing page flows before any request is sent', async () => {
  const { sent, send } = stripeStandIn();
  await assert.rejects(openBillingPage({ ...input, flow: 'refund_everything' }, { send }), /flow must be one of/);
  assert.equal(sent.length, 0);
});

test('reads the purchase as the buyer sees it: plan, renewal, card and receipts, with no secrets', async () => {
  const { sent, send } = stripeStandIn({
    'GET /v1/subscriptions/sub_sample0001': flowSubscription,
    'GET /v1/invoices': { data: [
      { id: 'in_sample0002', number: 'ABC-0002', created: 1795400000, status: 'paid', amount_paid: 2400, currency: 'usd', hosted_invoice_url: 'https://invoice.stripe.com/i/sample0002' },
      { id: 'in_sample0001', number: 'ABC-0001', created: 1792800000, status: 'paid', amount_paid: 1200, currency: 'usd', hosted_invoice_url: 'http://plain.example/receipt' },
    ] },
  });
  const page = await readBillingPage(input, { send });
  assert.deepEqual(page, {
    subscription_id: 'sub_sample0001',
    status: 'active',
    cancel_at_period_end: false,
    renews_at: new Date(1798000000 * 1000).toISOString(),
    ends_at: null,
    plan: { label: 'Bread box', amount_cents: 1200, currency: 'usd', interval: 'month', quantity: 2 },
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    receipts: [
      { id: 'in_sample0002', number: 'ABC-0002', created_at: new Date(1795400000 * 1000).toISOString(), status: 'paid', amount_paid_cents: 2400, currency: 'usd', receipt_url: 'https://invoice.stripe.com/i/sample0002' },
      { id: 'in_sample0001', number: 'ABC-0001', created_at: new Date(1792800000 * 1000).toISOString(), status: 'paid', amount_paid_cents: 1200, currency: 'usd', receipt_url: null },
    ],
  });
  assert.doesNotMatch(JSON.stringify(page), /fingerprint|must-not-leak|pm_sample|sk_/);
  const receipts = sent.find(request => request.url.includes('/v1/invoices'));
  assert.match(receipts.url, /subscription=sub_sample0001/);
});

test('a purchase set to end at period end says when it ends and does not say it renews', async () => {
  const { send } = stripeStandIn({ 'GET /v1/subscriptions/sub_sample0001': { ...flowSubscription, cancel_at_period_end: true } });
  const page = await readBillingPage(input, { send });
  assert.equal(page.cancel_at_period_end, true);
  assert.equal(page.renews_at, null);
  assert.equal(page.ends_at, new Date(1798000000 * 1000).toISOString());
});

test('the purchase read refuses a subscription id that is not a sub_ id before any request is sent', async () => {
  const { sent, send } = stripeStandIn();
  await assert.rejects(readBillingPage({ subscription_id: 'in_sample0001' }, { send }), /subscription_id/);
  assert.equal(sent.length, 0);
});
