// Stripe events since a time, read from a fake Stripe that answers from a queue. No key and no network.
// Proves the query sent, the paging (starting_after) and the order of the rows, that one event yields the same payment
// row as the webhook check for the same event, and the refusals (unknown kind, no time, a time past Stripe's 30 days).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { checkAStripeEvent, listStripeEventsAsPaymentEvents } from '../do-work/take-payments.mjs';

const NOW = 1_790_000_000;
const DAY = 86_400;

function fakeStripe(...replies) {
  const sent = [];
  const queue = [...replies];
  const send = async request => { sent.push(request); return queue.shift() ?? {}; };
  return { sent, send };
}

const event = (id, created, type, object = {}) => ({ id, object: 'event', created, type, livemode: false, data: { object: { id: `obj_${id}`, ...object } } });

const checkout = (id, created) => event(id, created, 'checkout.session.completed', {
  id: `cs_${id}`, amount_total: 29900, amount_subtotal: 29900, currency: 'usd', subscription: 'sub_test_1',
  metadata: { offer_id: 'offer:seat', price_option_id: 'price:seat-monthly' },
  customer_details: { email: 'buyer@example.com', name: 'Buyer' },
});

describe('Stripe events since a time', () => {
  it('sends the kinds, the time and the page size, and pages older with starting_after', async () => {
    const { sent, send } = fakeStripe(
      { data: [checkout('evt_3', NOW - 100), checkout('evt_2', NOW - 200)], has_more: true },
      { data: [checkout('evt_1', NOW - 300)], has_more: false },
    );
    const first = await listStripeEventsAsPaymentEvents({ since_unix: NOW - 1000, now_unix: NOW, limit: 2 }, { send });
    assert.equal(first.complete, false);
    assert.equal(first.next_cursor, 'evt_2');
    const second = await listStripeEventsAsPaymentEvents({ since_unix: NOW - 1000, now_unix: NOW, limit: 2, starting_after: first.next_cursor }, { send });
    const read = { payment_events: [...second.payment_events, ...first.payment_events], complete: second.complete, next_cursor: second.next_cursor, cursor_too_old: false, left_out: first.left_out + second.left_out };
    assert.equal(sent[0].method, 'GET');
    assert.match(sent[0].url, /\/v1\/events\?/);
    const query = decodeURIComponent(sent[0].url);
    assert.match(query, /limit=2/);
    assert.match(query, /created\[gte\]=1789999000/);
    assert.match(query, /types\[0\]=payment_intent\.succeeded&types\[1\]=checkout\.session\.completed/);
    assert.match(sent[1].url, /starting_after=evt_2/);
    assert.deepEqual(read.payment_events.map(row => row.id), ['payment-event:checkout:cs_evt_1', 'payment-event:checkout:cs_evt_2', 'payment-event:checkout:cs_evt_3']);
    assert.equal(read.complete, true);
    assert.equal(read.next_cursor, null);
    assert.equal(read.cursor_too_old, false);
    assert.equal(read.left_out, 0);
  });

  it('an incomplete read names the id to continue from', async () => {
    const { send } = fakeStripe({ data: [checkout('evt_9', NOW - 10), checkout('evt_8', NOW - 20)], has_more: true });
    const read = await listStripeEventsAsPaymentEvents({ since_unix: NOW - 1000, now_unix: NOW }, { send });
    assert.equal(read.complete, false);
    assert.equal(read.next_cursor, 'evt_8');
    assert.deepEqual(read.payment_events.map(row => row.id), ['payment-event:checkout:cs_evt_8', 'payment-event:checkout:cs_evt_9']);
  });

  it('one event gives the same payment row as the webhook check for the same event', async () => {
    const stripeEvent = checkout('evt_parity', NOW - 5);
    const payload = JSON.stringify(stripeEvent);
    const signature = createHmac('sha256', 'whsec_test').update(`${NOW}.${payload}`, 'utf8').digest('hex');
    const webhook = await checkAStripeEvent({ payload, signature_header: `t=${NOW},v1=${signature}`, now_seconds: NOW }, { secrets: { webhookSecret: 'whsec_test' } });
    assert.equal(webhook.admitted, true);
    const { send } = fakeStripe({ data: [stripeEvent], has_more: false });
    const listed = await listStripeEventsAsPaymentEvents({ since_unix: NOW - 1000, now_unix: NOW }, { send });
    assert.deepEqual(listed.payment_events[0], webhook.payment_event);
  });

  it('a paid invoice is read for its PaymentIntent, so its row is the payment\'s row, and a failed read keeps nothing', async () => {
    const invoice = event('evt_inv', NOW - 3, 'invoice.paid', { id: 'in_1', billing_reason: 'subscription_create', amount_paid: 2900, currency: 'usd', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1', metadata: { offer_id: 'offer:seat' } } } });
    const payments = (rows) => async request => (request.url.includes('invoice_payments') ? { data: rows } : { data: [invoice], has_more: false });
    const read = await listStripeEventsAsPaymentEvents({ since_unix: NOW - 1000, now_unix: NOW }, { send: payments([{ status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_1' } }]) });
    assert.deepEqual(read.payment_events.map(row => [row.id, row.event_kind, row.attributes.provider_object_ref, row.attributes.invoice_ref]), [['payment-event:payment:pi_1', 'payment.confirmed', 'pi_1', 'in_1']]);
    await assert.rejects(listStripeEventsAsPaymentEvents({ since_unix: NOW - 1000, now_unix: NOW }, { send: payments([{ status: 'open', payment: { type: 'payment_intent', payment_intent: 'pi_2' } }]) }), /exactly one is needed/);
  });

  it('counts a listed event whose kind the map does not keep, and keeps no row for it', async () => {
    const { send } = fakeStripe({ data: [event('evt_other', NOW - 1, 'customer.created'), checkout('evt_ok', NOW - 2)], has_more: false });
    const read = await listStripeEventsAsPaymentEvents({ since_unix: NOW - 1000, now_unix: NOW }, { send });
    assert.deepEqual(read.payment_events.map(row => row.id), ['payment-event:checkout:cs_evt_ok']);
    assert.equal(read.left_out, 1);
  });

  it('refuses a kind the map does not keep, before any request is sent', async () => {
    const { sent, send } = fakeStripe();
    await assert.rejects(listStripeEventsAsPaymentEvents({ since_unix: NOW - 1000, now_unix: NOW, types: ['customer.created'] }, { send }), /Not an event kind the event map keeps: customer\.created/);
    assert.equal(sent.length, 0);
  });

  it('refuses a read with no whole-second time', async () => {
    const { sent, send } = fakeStripe();
    await assert.rejects(listStripeEventsAsPaymentEvents({ now_unix: NOW }, { send }), /since_unix/);
    assert.equal(sent.length, 0);
  });

  it('reports a time older than Stripe keeps as cursor_too_old and sends nothing', async () => {
    const { sent, send } = fakeStripe();
    const read = await listStripeEventsAsPaymentEvents({ since_unix: NOW - 31 * DAY, now_unix: NOW }, { send });
    assert.deepEqual(read, { payment_events: [], next_cursor: null, complete: false, cursor_too_old: true, left_out: 0 });
    assert.equal(sent.length, 0);
  });
});
