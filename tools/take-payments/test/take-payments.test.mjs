// The functions the rows run, with a stand-in records door and a stand-in Stripe. Proves the money rules: nothing is
// sent without the person's own key, the key is never in a request, an answer or an error, a webhook is believed only
// after its replay window and signature, a payout needs the person's explicit word, and a rehearsal refuses a live key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  cancelAStripeSubscription,
  checkAStripeEvent,
  checkWhatWasPaid,
  paySomeoneAShare,
  priceASale,
  rehearseASchedule,
  setUpSomeoneIPay,
  setUpStripePaymentLinks,
  showOffersForABuyer,
  startAPayeeCheckout,
  startAStripeCheckout,
} from '../do-work/take-payments.mjs';
import { heldKey, makeStripeSender, StripeError } from '../do-work/stripe-send.mjs';
import { sessionIntentFromQuote, serializeQuote, SessionIntentError } from '../do-work/session-intent.ts';
import { buildCheckoutMaterialQuote } from '../read-data/checkout-quote.ts';
import { readCheckoutOffers } from '../../funnels-and-offers/read-data/read-offers.ts';

const SECRET_KEY = 'sk_test_fixture_key_value';

const offerRows = [
  { kind: 'commercial-offer', id: 'offer:box', label: 'Bread box', access_refs: ['access:box'], sort_order: 1, price_options: [{ id: 'price:box:monthly', label: 'Monthly', amount_cents: 1200, currency: 'usd', payment_timing: 'subscription', interval: 'month' }] },
  { kind: 'commercial-offer', id: 'offer:cake', label: 'Cake', access_refs: [], sort_order: 2, price_options: [{ id: 'price:cake', label: 'One cake', amount_cents: 2500, currency: 'usd', payment_timing: 'one_time' }] },
];
const attempt = { checkoutAttemptId: 'attempt-000000000001', checkoutStartedAt: '2026-01-02T03:04:05Z' };
const urls = { success_url: 'https://bakery.example/ok?session={CHECKOUT_SESSION_ID}', cancel_url: 'https://bakery.example/no' };

/** A stand-in Stripe that records every request it is given and answers from a queue. */
function stripe(...replies) {
  const sent = [];
  const queue = [...replies];
  return { sent, context: { send: async request => { sent.push(request); return queue.shift() ?? {}; }, door: doorOf({}) } };
}
/** A stand-in records door holding records by type. */
function doorOf(byType) {
  return { async *list({ type }) { for (const value of byType[type] ?? []) yield { id: value.id, type, value }; } };
}

test('pricing a sale reads the offers from the person\'s records and shows what is due', async () => {
  const context = { door: doorOf({ 'commercial-offer': offerRows }) };
  const { quote, material } = await priceASale({ ...attempt, offerId: 'offer:cake', priceOptionId: 'price:cake' }, context);
  assert.equal(quote.amountDueTodayCents, '2500');
  assert.equal(quote.paymentMode, 'one_time');
  assert.equal(material.amountDueTodayCents, '2500');
  assert.deepEqual(material.accessRefs, []);
  // the whole answer is JSON: no bigint
  assert.doesNotThrow(() => JSON.stringify({ quote, material }));
});

test('starting a checkout sends one request with no key on it and returns the hosted address', async () => {
  const { sent, context } = stripe({ id: 'cs_1', url: 'https://pay.example/cs_1' });
  const started = await startAStripeCheckout({ ...attempt, offers: offerRows, offerId: 'offer:box', priceOptionId: 'price:box:monthly', consent: { billing: true, legal: true }, customer: { email: 'ana@example.com', firstName: 'Ana', lastName: 'Baker' }, ...urls }, context);
  assert.equal(started.redirectUrl, 'https://pay.example/cs_1');
  assert.equal(started.amountDueTodayCents, '1200');
  assert.equal(sent.length, 1);
  const form = new URLSearchParams(sent[0].body);
  assert.equal(form.get('mode'), 'subscription');
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '1200');
  assert.equal(form.get('success_url'), urls.success_url);
  assert.ok(sent[0].headers['Idempotency-Key'].startsWith('checkout-session:create:attempt-000000000001:'));
  assert.doesNotMatch(JSON.stringify(sent), /Authorization|Bearer|sk_/);
});

test('a checkout is refused without the buyer\'s agreement or without return addresses, and nothing is sent', async () => {
  const { sent, context } = stripe();
  const base = { ...attempt, offers: offerRows, offerId: 'offer:box', priceOptionId: 'price:box:monthly', ...urls };
  await assert.rejects(startAStripeCheckout({ ...base, consent: { billing: true, legal: false } }, context), /Agree to the billing and legal terms/);
  await assert.rejects(startAStripeCheckout({ ...base, consent: { billing: true, legal: true }, success_url: '' }, context), /success_url and cancel_url are required/);
  assert.equal(sent.length, 0);
});

test('with no key held, a call that would need Stripe refuses and says where the key goes', async () => {
  const context = { door: doorOf({}), readKey: () => { throw new Error('no such descriptor'); } };
  await assert.rejects(cancelAStripeSubscription({ subscription_id: 'sub_1' }, context), /put your Stripe key in your held values/);
});

test('the held key is read once from its descriptor and never appears in an error', async () => {
  assert.equal(heldKey(4, () => `  ${SECRET_KEY}\n`), SECRET_KEY);
  assert.throws(() => heldKey(4, () => ''), StripeError);
  assert.throws(() => heldKey(4, () => { throw new Error('closed'); }), /held values/);
  const sender = makeStripeSender({
    key: SECRET_KEY,
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.Authorization, `Bearer ${SECRET_KEY}`);
      return new Response(JSON.stringify({ error: { message: `Invalid API Key provided: ${SECRET_KEY}` } }), { status: 401 });
    },
  });
  await assert.rejects(sender({ method: 'GET', url: 'https://api.stripe.com/v1/balance', headers: {} }), error => {
    assert.ok(error instanceof StripeError);
    assert.equal(error.status, 401);
    assert.doesNotMatch(error.message, /sk_test/);
    return true;
  });
});

test('a webhook is believed only inside its window and with a matching signature', () => {
  const secret = 'whsec_fixture_signing_secret';
  const now = 1790000000;
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', created: now, data: { object: { id: 'cs_1', amount_total: 2500, currency: 'usd', payment_status: 'paid', metadata: { offer_id: 'offer:cake' } } } });
  const header = (t, body = payload, key = secret) => `t=${t},v1=${createHmac('sha256', key).update(`${t}.${body}`).digest('hex')}`;
  const context = { secrets: { webhookSecret: secret } };

  const good = checkAStripeEvent({ payload, signature_header: header(now), now_seconds: now }, context);
  assert.equal(good.admitted, true);
  assert.equal(good.event_kind, 'payment.confirmed');
  assert.equal(good.payment_event.kind, 'payment-event');
  assert.equal(good.payment_event.id, 'payment-event:evt_1');
  assert.equal(good.payment_event.attributes.offer_id, 'offer:cake');
  assert.doesNotMatch(JSON.stringify(good), /whsec_/);

  assert.deepEqual(checkAStripeEvent({ payload, signature_header: header(now, payload, 'whsec_another'), now_seconds: now }, context), { admitted: false, reason: 'signature-mismatch', payment_event: null });
  assert.equal(checkAStripeEvent({ payload: `${payload} `, signature_header: header(now), now_seconds: now }, context).reason, 'signature-mismatch');
  assert.equal(checkAStripeEvent({ payload, signature_header: header(now - 10_000), now_seconds: now }, context).reason, 'timestamp-outside-tolerance');
  assert.equal(checkAStripeEvent({ payload, signature_header: 'nonsense', now_seconds: now }, context).reason, 'malformed-signature-header');
  const unknown = JSON.stringify({ id: 'evt_2', type: 'some.other.event', created: now, data: { object: {} } });
  assert.equal(checkAStripeEvent({ payload: unknown, signature_header: header(now, unknown), now_seconds: now }, context).reason, 'unmapped-event-type');
});

test('what a buyer paid must be a price the offer declares', async () => {
  const context = { door: doorOf({ 'commercial-offer': offerRows }) };
  assert.deepEqual(await checkWhatWasPaid({ offer_id: 'offer:cake', paid: { amountCents: 2500, currency: 'USD' } }, context), { matches: true, reason: '' });
  const wrong = await checkWhatWasPaid({ offer_id: 'offer:cake', paid: { amountCents: 100, currency: 'usd' } }, context);
  assert.equal(wrong.matches, false);
  assert.match(wrong.reason, /does not match any price/);
  await assert.rejects(checkWhatWasPaid({ offer_id: 'offer:none', paid: { amountCents: 1, currency: 'usd' } }, context), /not one of your offers/);
});

test('eligibility rules are the person\'s records, and a held ref changes what is shown', async () => {
  const context = { door: doorOf({ 'commercial-offer': offerRows, 'offer-eligibility-rule': [{ id: 'elig:1', offer_id: 'offer:cake', requires_held: ['access:box'] }] }) };
  assert.deepEqual((await showOffersForABuyer({ held_access_refs: [] }, context)).offers.map(offer => offer.id), ['offer:box']);
  assert.deepEqual((await showOffersForABuyer({ held_access_refs: ['access:box'] }, context)).offers.map(offer => offer.id), ['offer:box', 'offer:cake']);
});

test('payment links are made once per priced option and carry no key', async () => {
  const stripeAnswers = new Map([
    ['GET /v1/payment_links', { data: [] }],
    ['GET /v1/prices', { data: [] }],
    ['POST /v1/products', { id: 'prod_1' }],
    ['POST /v1/prices', { id: 'price_1' }],
    ['POST /v1/payment_links', { id: 'plink_1', url: 'https://buy.example/1' }],
    ['GET /v1/billing_portal/configurations', { data: [{ id: 'bpc_1', metadata: { owner: 'bakery-a' }, login_page: { url: 'https://billing.example/p' } }] }],
  ]);
  const sent = [];
  const context = { door: doorOf({ 'commercial-offer': offerRows }), send: async request => { sent.push(request); return stripeAnswers.get(`${request.method} ${new URL(request.url).pathname}`) ?? { data: [] }; } };
  const made = await setUpStripePaymentLinks({ owner: 'bakery-a', after_payment_url: 'https://bakery.example/' }, context);
  assert.equal(made.links.length, 2);
  assert.equal(made.portal_url, 'https://billing.example/p');
  assert.doesNotMatch(JSON.stringify(sent), /Authorization|Bearer|sk_/);
});

test('a payee checkout keeps the platform fee back, and onboarding reports what Stripe still needs', async () => {
  const checkout = stripe({ id: 'cs_9', url: 'https://pay.example/cs_9' });
  const started = await startAPayeeCheckout({ offers: offerRows, offer_id: 'offer:cake', price_option_id: 'price:cake', payee_account: 'acct_baker', fee: { percent: 10 }, payer_ref: 'person-1', ...urls, idempotency_key: 'k-9' }, checkout.context);
  assert.deepEqual([started.redirectUrl, started.platform_fee_cents], ['https://pay.example/cs_9', '250']);
  const form = new URLSearchParams(checkout.sent[0].body);
  assert.equal(form.get('payment_intent_data[application_fee_amount]'), '250');
  assert.equal(form.get('payment_intent_data[transfer_data][destination]'), 'acct_baker');

  const onboarding = stripe({ id: 'acct_new', capabilities: { transfers: 'inactive' }, requirements: { currently_due: ['tos_acceptance.date'] } }, { url: 'https://connect.example/onboard' });
  const setup = await setUpSomeoneIPay({ settings: { country: 'US', controller: { fees: { payer: 'application' } }, capabilities: ['transfers'] }, email: 'baker@example.com', owner: 'bakery-a', payee_ref: 'baker:1', refresh_url: 'https://bakery.example/r', return_url: 'https://bakery.example/d' }, onboarding.context);
  assert.deepEqual(setup, { account: 'acct_new', readiness: { can_be_paid: false, onboarding_done: false, payouts_enabled: false, due: ['tos_acceptance.date'] }, onboarding_url: 'https://connect.example/onboard' });
});

test('paying a share out needs the person\'s explicit word in the same request', async () => {
  const payout = stripe({ id: 'tr_1', amount: 500, currency: 'usd', destination: 'acct_baker' });
  const share = { amount_cents: 500, currency: 'USD', destination: 'acct_baker', idempotency_key: 'k-5' };
  await assert.rejects(paySomeoneAShare(share, payout.context), /confirm_moves_money: true/);
  assert.equal(payout.sent.length, 0);
  assert.deepEqual(await paySomeoneAShare({ ...share, confirm_moves_money: true }, payout.context), { transfer: 'tr_1', amount_cents: 500, currency: 'usd', destination: 'acct_baker' });
  assert.equal(payout.sent[0].url, 'https://api.stripe.com/v1/transfers');
});

test('a rehearsal refuses any key that is not a test key before it builds a request', async () => {
  const { sent, context } = stripe();
  const input = { payment_schedule: { charges: [{ amount_cents: '800', days_after_signup: 0 }, { amount_cents: '3200', days_after_signup: 7 }], repeat: null }, product_name: 'Course' };
  await assert.rejects(rehearseASchedule(input, { ...context, key: 'sk_live_fixture' }), /not a Stripe test key/);
  assert.equal(sent.length, 0);
  await assert.rejects(rehearseASchedule({ ...input, product_name: '' }, { ...context, key: 'sk_test_fixture' }), /product name is required/);
});

test('a rehearsal builds the later phases and reports what Stripe says', async () => {
  const { sent, context } = stripe({ id: 'cus_1' }, { id: 'prod_1' }, { id: 'price_1' }, { id: 'price_2' }, {
    id: 'sched_1', status: 'active', phases: [{ start_date: 1790000000 }, { start_date: 1790000000 + 30 * 86400 }],
  });
  const result = await rehearseASchedule({
    payment_schedule: { charges: [{ amount_cents: '800', days_after_signup: 0 }, { amount_cents: '3200', days_after_signup: 7 }], repeat: { amount_cents: '4000', interval: 'month', first_days_after_signup: 37 } },
    product_name: 'Course',
  }, { ...context, key: 'rk_test_fixture' });
  assert.equal(result.schedule_id, 'sched_1');
  assert.deepEqual(result.what_stripe_says, [{ phase: 0, amount_cents: 3200, days_after_start: 0 }, { phase: 1, amount_cents: 4000, days_after_start: 30 }]);
  assert.deepEqual(sent.map(request => new URL(request.url).pathname), ['/v1/customers', '/v1/products', '/v1/prices', '/v1/prices', '/v1/subscription_schedules']);
});

const quoteOf = (rows, offerId, priceOptionId, extra = {}) => serializeQuote(buildCheckoutMaterialQuote(readCheckoutOffers(rows), { ...attempt, offerId, priceOptionId, ...extra }));

test('a session intent follows the quote: recurring mode and amount for a subscription, one charge for a one-time price', () => {
  const subscription = sessionIntentFromQuote(quoteOf(offerRows, 'offer:box', 'price:box:monthly'), urls);
  assert.equal(subscription.session.payment_mode, 'subscription');
  assert.equal(subscription.session.line_items[0].amount_cents, 1200);
  assert.equal(subscription.session.line_items[0].billing_mode, 'recurring');
  const once = sessionIntentFromQuote(quoteOf(offerRows, 'offer:cake', 'price:cake'), urls);
  assert.equal(once.session.payment_mode, 'payment');
  assert.equal(once.session.line_items[0].billing_mode, 'one_time');
  assert.equal(once.session.schedule.charges[0].amount_cents, '2500', 'whole cents cross as text');
});

test('the idempotency key is stable for one quote and changes when the price-determining fields change', () => {
  const a = sessionIntentFromQuote(quoteOf(offerRows, 'offer:box', 'price:box:monthly'), urls).idempotency_key;
  const again = sessionIntentFromQuote(quoteOf(offerRows, 'offer:box', 'price:box:monthly'), urls).idempotency_key;
  const other = sessionIntentFromQuote(quoteOf(offerRows, 'offer:cake', 'price:cake'), urls).idempotency_key;
  assert.equal(a, again);
  assert.notEqual(a, other);
});

test('a larger first invoice becomes a one-time line beside the recurring one; a smaller one is refused', () => {
  const rows = [{ ...offerRows[0], price_options: [{ ...offerRows[0].price_options[0], id: 'p', initial_amount_cents: 4200 }] }];
  const intent = sessionIntentFromQuote(quoteOf(rows, 'offer:box', 'p'), urls);
  assert.deepEqual(intent.session.line_items.map(item => [item.billing_mode, item.amount_cents]), [['recurring', 1200], ['one_time', 3000]]);
  assert.equal(intent.session.initial_amount_cents, 4200);
  assert.throws(() => sessionIntentFromQuote({ ...quoteOf(offerRows, 'offer:box', 'price:box:monthly'), amountDueTodayCents: '100' }, urls), /cannot be less than its recurring amount/);
});

test('an installment plan with no valid count, a free quote and missing return addresses are all refused', () => {
  const installments = [{ ...offerRows[0], price_options: [{ ...offerRows[0].price_options[0], id: 'i', payment_timing: 'installment', installment_count: 1 }] }];
  assert.throws(() => sessionIntentFromQuote(quoteOf(installments, 'offer:box', 'i'), urls), SessionIntentError);
  const free = [{ ...offerRows[1], price_options: [{ id: 'f', label: 'Free', amount_cents: 0, currency: 'usd', payment_timing: 'free' }] }];
  assert.throws(() => sessionIntentFromQuote(quoteOf(free, 'offer:cake', 'f'), urls), /positive amount is required/);
  assert.throws(() => sessionIntentFromQuote(quoteOf(offerRows, 'offer:cake', 'price:cake'), {}), /success_url and cancel_url are required/);
});
