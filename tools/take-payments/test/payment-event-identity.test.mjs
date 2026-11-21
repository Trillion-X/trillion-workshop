// One Stripe checkout gives one payment row id whether it arrives by webhook, by the event list or by the checkout list.
// Every other event kind keeps its Stripe event id. No key and no network: a signed payload and fake Stripe replies.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { checkAStripeEvent, listCompletedCheckoutsAsPaymentEvents, listStripeEventsAsPaymentEvents } from '../do-work/take-payments.mjs';

const NOW = 1_790_000_000;
const SECRET = 'whsec_identity_fixture';
const offers = [{ kind: 'commercial-offer', id: 'offer:seat', label: 'Seat', access_refs: ['access:seat'], price_options: [{ id: 'price:seat-monthly', label: 'Monthly', amount_cents: 29900, currency: 'usd', payment_timing: 'one_time' }] }];

const session = {
  id: 'cs_identity', object: 'checkout.session', status: 'complete', created: NOW - 60, amount_total: 29900, amount_subtotal: 29900,
  currency: 'usd', subscription: null, mode: 'payment', payment_intent: 'pi_identity', payment_status: 'paid', customer_details: { email: 'buyer@example.test' },
  metadata: { offer_id: 'offer:seat', price_option_id: 'price:seat-monthly' },
};
const checkoutEvent = { id: 'evt_identity', type: 'checkout.session.completed', created: NOW - 60, data: { object: session } };

async function signed(event) {
  const payload = JSON.stringify(event);
  const signature = createHmac('sha256', SECRET).update(`${NOW}.${payload}`, 'utf8').digest('hex');
  return checkAStripeEvent({ payload, signature_header: `t=${NOW},v1=${signature}`, now_seconds: NOW }, { secrets: { webhookSecret: SECRET } });
}

function fakeStripe(reply) {
  return async () => reply;
}

describe('one checkout is one payment row id on every path', () => {
  it('the webhook, the event list and the checkout list name the same checkout the same way', async () => {
    const webhook = await signed(checkoutEvent);
    assert.equal(webhook.admitted, true);
    const listedEvents = await listStripeEventsAsPaymentEvents({ since_unix: NOW - 1000, now_unix: NOW }, { send: fakeStripe({ data: [checkoutEvent], has_more: false }) });
    const listedCheckouts = await listCompletedCheckoutsAsPaymentEvents({ created_after_unix: 0, offers }, { send: fakeStripe({ data: [session], has_more: false }) });

    assert.equal(webhook.payment_event.id, 'payment-event:payment:pi_identity');
    assert.equal(listedEvents.payment_events[0].id, webhook.payment_event.id);
    assert.equal(listedCheckouts.events[0].id, webhook.payment_event.id);
    assert.equal(listedEvents.payment_events[0].attributes.provider_event_id, 'evt_identity');
    assert.deepEqual(listedEvents.payment_events[0], webhook.payment_event);
  });

  it('a refund keeps its Stripe event id on every path', async () => {
    const refund = { id: 'evt_refund', type: 'charge.refunded', created: NOW - 30, data: { object: { id: 'ch_1', amount_refunded: 29900, currency: 'usd', metadata: { offer_id: 'offer:seat' } } } };
    const webhook = await signed(refund);
    assert.equal(webhook.admitted, true);
    assert.equal(webhook.payment_event.id, 'payment-event:evt_refund');
    const listed = await listStripeEventsAsPaymentEvents({ since_unix: NOW - 1000, now_unix: NOW }, { send: fakeStripe({ data: [refund], has_more: false }) });
    assert.equal(listed.payment_events[0].id, 'payment-event:evt_refund');
  });
});
