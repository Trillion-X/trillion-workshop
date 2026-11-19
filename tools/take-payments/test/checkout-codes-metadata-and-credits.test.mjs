// A checkout code's floor and duration, the caller's metadata on a checkout, and a customer credit, against a stand-in
// Stripe that records every request it is given and answers from a fixture. A made-up bakery's rows; the arithmetic and
// the request shapes are what is proved. Nothing here reaches Stripe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { giveACustomerCredit, startAStripeCheckout } from '../do-work/take-payments.mjs';
import { buildCheckoutMaterialQuote } from '../read-data/checkout-quote.ts';
import { readCheckoutCodeAdjustments } from '../read-data/read-code-adjustments.ts';
import { readCheckoutOffers } from '../../funnels-and-offers/read-data/read-offers.ts';

const attempt = { checkoutAttemptId: 'attempt-000000000001', checkoutStartedAt: '2026-01-02T03:04:05Z' };
const urls = { success_url: 'https://bakery.example/ok', cancel_url: 'https://bakery.example/no' };
const consent = { billing: true, legal: true };
const customer = { email: 'ana@example.com', firstName: 'Ana', lastName: 'Baker' };

const boxOffer = { kind: 'commercial-offer', id: 'offer:box', label: 'Bread box', access_refs: ['access:box'], sort_order: 1, price_options: [{
  id: 'price:box:monthly', label: 'Monthly', amount_cents: 9900, currency: 'usd', payment_timing: 'subscription', interval: 'month',
}] };
// A price with a floor: the buyer chooses any amount from the floor up.
const tutorOffer = { kind: 'commercial-offer', id: 'offer:tutor', label: 'Tutoring', access_refs: ['access:tutor'], sort_order: 2, price_options: [{
  id: 'price:tutor:monthly', label: 'Monthly', amount_cents: 9900, currency: 'usd', payment_timing: 'subscription', interval: 'month',
  voluntary_amount_policy: { allow_custom: true, allow_free: false, currency: 'usd', min_cents: 9900, suggested_cents: [9900, 12000] },
}] };

const friendOnce = { kind: 'checkout-code-adjustment', id: 'adj:friend', label: 'Friend', code: 'FRIEND25', duration: 'once', adjustment: { kind: 'amount_cents', amount_cents: 2500, currency: 'usd' }, applies_to: { offer_ids: ['offer:box', 'offer:tutor'] } };
const halfForever = { kind: 'checkout-code-adjustment', id: 'adj:half', label: 'Half', code: 'HALF', adjustment: { kind: 'percent', percent: 50 }, applies_to: { offer_ids: ['offer:tutor'] } };
const everything = { kind: 'checkout-code-adjustment', id: 'adj:all', label: 'Everything', code: 'ALL', duration: 'once', adjustment: { kind: 'percent', percent: 100 }, applies_to: { offer_ids: ['offer:box'] } };

/** A stand-in Stripe: coupons and Checkout Sessions get the fixture ids; every request is recorded. */
function stripe(answer = {}) {
  const sent = [];
  const context = {
    send: async (request) => {
      sent.push(request);
      const path = new URL(request.url).pathname;
      if (path === '/v1/coupons') return { id: 'coupon_1' };
      if (path === '/v1/checkout/sessions') return { id: 'cs_1', url: 'https://pay.example/cs_1' };
      return answer[path] ?? {};
    },
  };
  return { sent, context };
}

const formOf = request => new URLSearchParams(request.body);
const checkoutOf = sent => sent.find(request => new URL(request.url).pathname === '/v1/checkout/sessions');
const couponOf = sent => sent.find(request => new URL(request.url).pathname === '/v1/coupons');
const startWith = (context, extra, offers = [boxOffer, tutorOffer], adjustments = [friendOnce, halfForever, everything]) => startAStripeCheckout({
  ...attempt, ...urls, consent, customer, offers, adjustments, ...extra,
}, context);

test('a checkout code may take the amount due below a floor; the chosen price still has to reach the floor', () => {
  const offers = readCheckoutOffers([tutorOffer]);
  const adjustments = readCheckoutCodeAdjustments([friendOnce, halfForever]);
  const ask = (customerSelectedAmountCents, checkoutCode) => buildCheckoutMaterialQuote(offers, {
    ...attempt, offerId: 'offer:tutor', priceOptionId: 'price:tutor:monthly', customerSelectedAmountCents, checkoutCode,
  }, adjustments);

  // A once code takes $25 off the first invoice of a $99 floor, and the price keeps repeating at $99.
  const onceCode = ask(9900, 'FRIEND25');
  assert.equal(onceCode.amountDueTodayCents, 7400n);
  assert.equal(onceCode.recurringAmountCents, 9900n);
  // A code that repeats as a percentage takes the whole price below the floor, as it always did.
  const forever = ask(9900, 'HALF');
  assert.equal(forever.amountDueTodayCents, 4950n);
  assert.equal(forever.recurringAmountCents, 4950n);
  // The floor is still checked on the chosen price, before any code.
  assert.throws(() => ask(5000, undefined), /Enter at least 9900 usd/);
  assert.throws(() => ask(5000, 'FRIEND25'), /Enter at least 9900 usd/);
});

test('a once code keeps the recurring price full, and the first invoice is taken off by a coupon made for it', async () => {
  const { sent, context } = stripe();
  const started = await startWith(context, { offerId: 'offer:box', priceOptionId: 'price:box:monthly', checkoutCode: 'FRIEND25' });
  assert.equal(started.amountDueTodayCents, '7400');
  assert.equal(started.recurringAmountCents, '9900');
  assert.equal(sent.length, 2, 'one coupon, then one checkout session');

  const coupon = couponOf(sent);
  assert.deepEqual(Object.fromEntries(formOf(coupon)), { amount_off: '2500', currency: 'usd', duration: 'once', 'metadata[adjustment_id]': 'adj:friend' });
  assert.equal(coupon.headers['Idempotency-Key'], 'checkout-coupon:adj:friend:2500:usd');

  const session = checkoutOf(sent);
  const form = formOf(session);
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '9900', 'the line stays the full price');
  assert.equal(form.get('line_items[0][price_data][recurring][interval]'), 'month');
  assert.equal(form.get('discounts[0][coupon]'), 'coupon_1');
  assert.equal(form.get('subscription_data[metadata][validated_amount_cents]'), '7400');
  assert.equal(form.get('metadata[initial_amount_cents]'), '7400');
});

test('a 100% once code leaves the first invoice at $0 and still a paid subscription, not a free one', async () => {
  const { sent, context } = stripe();
  const started = await startWith(context, { offerId: 'offer:box', priceOptionId: 'price:box:monthly', checkoutCode: 'ALL' });
  assert.equal(started.amountDueTodayCents, '0');
  assert.equal(started.recurringAmountCents, '9900');
  assert.equal(started.paymentMode, 'subscription');
  assert.equal(formOf(couponOf(sent)).get('amount_off'), '9900');
  assert.equal(formOf(checkoutOf(sent)).get('discounts[0][coupon]'), 'coupon_1');
});

test('a percentage code repeats the discounted amount, as before, and makes no coupon', async () => {
  const { sent, context } = stripe();
  const started = await startWith(context, { offerId: 'offer:tutor', priceOptionId: 'price:tutor:monthly', customerSelectedAmountCents: 9900, checkoutCode: 'HALF' });
  assert.equal(started.recurringAmountCents, '4950');
  assert.equal(sent.length, 1);
  assert.equal(formOf(checkoutOf(sent)).get('line_items[0][price_data][unit_amount]'), '4950');
  assert.equal(formOf(checkoutOf(sent)).has('discounts[0][coupon]'), false);
});

test('the caller\'s metadata is carried onto the session and its subscription, and the checkout\'s own keys are refused', async () => {
  const { sent, context } = stripe();
  await startWith(context, { offerId: 'offer:box', priceOptionId: 'price:box:monthly', metadata: { referral_code: 'FRIEND1' } });
  const form = formOf(checkoutOf(sent));
  assert.equal(form.get('metadata[referral_code]'), 'FRIEND1');
  assert.equal(form.get('subscription_data[metadata][referral_code]'), 'FRIEND1');
  assert.equal(form.get('metadata[offer_id]'), 'offer:box', 'the checkout still names its own offer');

  const refused = stripe();
  const base = { offerId: 'offer:box', priceOptionId: 'price:box:monthly' };
  await assert.rejects(startWith(refused.context, { ...base, metadata: { offer_id: 'offer:other' } }), /metadata offer_id is set by the checkout itself/);
  await assert.rejects(startWith(refused.context, { ...base, metadata: { referral_code: 7 } }), /metadata referral_code must be text/);
  await assert.rejects(startWith(refused.context, { ...base, metadata: { ['k'.repeat(41)]: 'x' } }), /A metadata key is 1 to 40 characters/);
  await assert.rejects(startWith(refused.context, { ...base, metadata: { value: 'v'.repeat(501) } }), /metadata value must be text/);
  const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`key_${index}`, 'x']));
  await assert.rejects(startWith(refused.context, { ...base, metadata: tooMany }), /at most 50 keys/);
  assert.equal(refused.sent.length, 0, 'nothing is sent for a checkout whose metadata is refused');
});

test('a customer credit is one negative balance transaction, keyed so a repeated ask makes one credit', async () => {
  const { sent, context } = stripe({
    '/v1/customers/cus_123/balance_transactions': { id: 'cbtxn_1', object: 'customer_balance_transaction', amount: -2500, currency: 'usd', ending_balance: -2500 },
  });
  const credit = await giveACustomerCredit({
    customer: 'cus_123', amount_cents: 2500, currency: 'USD', description: 'Referral credit', idempotency_key: 'credit:referral:rule:sale-1',
  }, context);
  assert.deepEqual(credit, { balance_transaction: 'cbtxn_1', customer: 'cus_123', credit_cents: 2500, currency: 'usd', ending_balance: -2500 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(new URL(sent[0].url).pathname, '/v1/customers/cus_123/balance_transactions');
  assert.deepEqual(Object.fromEntries(formOf(sent[0])), { amount: '-2500', currency: 'usd', description: 'Referral credit' });
  assert.equal(sent[0].headers['Idempotency-Key'], 'credit:referral:rule:sale-1');
  assert.doesNotMatch(JSON.stringify(sent), /Authorization|Bearer|sk_/);
});

test('a customer credit refuses an answer that books another amount, and a malformed request before anything is sent', async () => {
  const booked = stripe({ '/v1/customers/cus_123/balance_transactions': { id: 'cbtxn_2', amount: -100, currency: 'usd' } });
  await assert.rejects(giveACustomerCredit({ customer: 'cus_123', amount_cents: 2500, currency: 'usd', description: 'Credit', idempotency_key: 'k1' }, booked.context), /booked -100 for this credit, not -2500/);

  const refused = stripe();
  const good = { customer: 'cus_123', amount_cents: 2500, currency: 'usd', description: 'Credit', idempotency_key: 'k1' };
  const bad = [
    { customer: '' },
    { amount_cents: 0 },
    { amount_cents: 25.5 },
    { currency: 'usd1' },
    { description: '' },
    { idempotency_key: '' },
  ];
  for (const change of bad) {
    await assert.rejects(giveACustomerCredit({ ...good, ...change }, refused.context));
  }
  assert.equal(refused.sent.length, 0);
});
