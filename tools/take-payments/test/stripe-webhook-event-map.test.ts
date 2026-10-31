// packages/stripe-payment-provider/tests/stripe-webhook-event-map.test.ts
//
// No-key proof for REV-LEDGER Part A ingestion: a verified Stripe webhook event
// maps to the GENERIC revenue PaymentEvent that revenue-ledger's projection
// consumes — correct event_kind (role lookup happens in revenue-ledger's
// config), config-keyed amount/currency/offer attributes, event.id idempotency,
// and fail-closed on unknown types. Fixtures are real Stripe webhook shapes;
// zero key, zero network.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from './expect.mjs';
// eslint-disable-next-line import/extensions
import { mapStripeWebhookEvent, loadWebhookEventMap } from '../do-work/map-stripe-webhook-event.mjs';

const packageRoot = join(import.meta.dirname, '..');
const eventMap = loadWebhookEventMap(join(packageRoot, 'read-data/stripe-webhook-event-map.json'));

// Real-shaped Stripe webhook events (trimmed to the fields the map reads).
const paymentIntentSucceeded = {
  id: 'evt_pi_1',
  type: 'payment_intent.succeeded',
  created: 1782086400,
  data: { object: { id: 'pi_123', amount_received: 50, currency: 'usd', metadata: { offer_id: 'launch' } } },
};
const chargeRefunded = {
  id: 'evt_refund_1',
  type: 'charge.refunded',
  created: 1782090000,
  data: { object: { id: 'ch_123', amount_refunded: 50, currency: 'usd', billing_details: { email: 'Buyer@Example.COM' }, metadata: { offer_id: 'launch' } } },
};
const invoicePaid = {
  id: 'evt_inv_1',
  type: 'invoice.paid',
  created: 1784678400,
  data: {
    object: {
      id: 'in_123',
      amount_paid: 2900,
      currency: 'usd',
      customer_email: 'renewing@example.com',
      parent: {
        type: 'subscription_details',
        subscription_details: {
          subscription: 'sub_123',
          metadata: { offer_id: 'membership', customer_email: 'renewing@example.com' },
        },
      },
    },
  },
};
const subscriptionDeleted = {
  id: 'evt_sub_end_1',
  type: 'customer.subscription.deleted',
  created: 1784678500,
  data: {
    object: {
      id: 'sub_123',
      currency: 'usd',
      status: 'canceled',
      metadata: {
        offer_id: 'membership',
        customer_email: 'renewing@example.com',
      },
    },
  },
};

describe('map-stripe-webhook-event → generic revenue PaymentEvent (no key)', () => {
  it('maps payment_intent.succeeded → payment.confirmed with config-keyed amount', () => {
    const ev = mapStripeWebhookEvent(paymentIntentSucceeded, eventMap);
    expect(ev).toMatchObject({
      event_id: 'evt_pi_1',
      event_kind: 'payment.confirmed',
      occurred_at: '2026-06-22T00:00:00.000Z',
      attributes: {
        amount_due_today_cents: 50, // == bakery revenue-projection-config.amount_field_path
        currency: 'usd',
        offer_id: 'launch',
        provider_object_ref: 'pi_123',
        provider_event_id: 'evt_pi_1',
      },
    });
  });

  it('maps charge.refunded → payment.refunded (config role = subtract) with refunded amount', () => {
    const ev = mapStripeWebhookEvent(chargeRefunded, eventMap);
    expect(ev.event_kind).toBe('payment.refunded');
    expect(ev.attributes.amount_due_today_cents).toBe(50);
    expect(ev.attributes.offer_id).toBe('launch');
  });

  it('charge.refunded carries the buyer subject (billing_details.email) — refund-family blocker #2', () => {
    // Without WHO, the revoke trigger cannot safely identify the account to
    // revoke (refund-revocation buildspec blocker #2). The subject is DATA:
    // one attribute_map row, zero decoder code (L090).
    const ev = mapStripeWebhookEvent(chargeRefunded, eventMap);
    expect(ev.attributes.customer_email).toBe('Buyer@Example.COM');
  });

  it('fail-closed: a refund with no billing email simply omits the subject (no guessed identity)', () => {
    const anonymous = { ...chargeRefunded, data: { object: { ...chargeRefunded.data.object, billing_details: {} } } };
    const ev = mapStripeWebhookEvent(anonymous, eventMap);
    expect(ev.attributes.customer_email).toBeUndefined();
  });

  it('maps invoice.paid → subscription.renewed with recurring amount + active status', () => {
    const ev = mapStripeWebhookEvent(invoicePaid, eventMap);
    expect(ev.event_kind).toBe('subscription.renewed');
    expect(ev.attributes.amount_due_today_cents).toBe(2900);
    expect(ev.attributes.recurring_amount_cents).toBe(2900);
    expect(ev.attributes.subscription_status).toBe('active');
    expect(ev.attributes.provider_object_ref).toBe('sub_123');
    expect(ev.attributes.offer_id).toBe('membership');
    expect(ev.attributes.customer_email).toBe('renewing@example.com');
  });

  it('maps checkout.session.completed subscription id through for grant-time enrichment', () => {
    const ev = mapStripeWebhookEvent({
      id: 'evt_checkout_sub_1',
      type: 'checkout.session.completed',
      created: 1782086400,
      data: {
        object: {
          id: 'cs_123',
          amount_total: 0,
          currency: 'usd',
          customer_details: { email: 'buyer@example.com' },
          metadata: { offer_id: 'membership' },
          subscription: 'sub_123',
        },
      },
    }, eventMap);
    expect(ev?.attributes.subscription_id).toBe('sub_123');
  });

  it('maps customer.subscription.deleted → subscription.ended with owner-stamped identity', () => {
    const ev = mapStripeWebhookEvent(subscriptionDeleted, eventMap);
    expect(ev).toMatchObject({
      event_id: 'evt_sub_end_1',
      event_kind: 'subscription.ended',
      attributes: {
        customer_email: 'renewing@example.com',
        offer_id: 'membership',
        provider_object_ref: 'sub_123',
        provider_event_id: 'evt_sub_end_1',
        subscription_status: 'canceled',
      },
    });
  });

  it('carries the paid-in-full retention marker so installment completion does not revoke access', () => {
    const completedInstallment = {
      ...subscriptionDeleted,
      id: 'evt_sub_end_installment',
      data: {
        object: {
          ...subscriptionDeleted.data.object,
          metadata: {
            ...subscriptionDeleted.data.object.metadata,
            installment_count: '4',
            entitlement_retained: 'true',
          },
        },
      },
    };
    const ev = mapStripeWebhookEvent(completedInstallment, eventMap);
    expect(ev.attributes.installment_count).toBe('4');
    expect(ev.attributes.entitlement_retained).toBe('true');
  });

  it('uses event.id as event_id for idempotent admit (SP4 replay-safe)', () => {
    expect(mapStripeWebhookEvent(paymentIntentSucceeded, eventMap).event_id).toBe('evt_pi_1');
    // Re-deliver the same event → identical mapped payload → same admit hash.
    expect(mapStripeWebhookEvent(paymentIntentSucceeded, eventMap))
      .toEqual(mapStripeWebhookEvent(paymentIntentSucceeded, eventMap));
  });

  it('fails closed on an unknown event type (no guessed revenue row)', () => {
    expect(mapStripeWebhookEvent({ id: 'evt_x', type: 'customer.created', created: 1, data: { object: {} } }, eventMap))
      .toBeNull();
    expect(mapStripeWebhookEvent(null, eventMap)).toBeNull();
    expect(mapStripeWebhookEvent({ id: 'e', data: {} }, eventMap)).toBeNull(); // no type
  });

  it('map carries no secret and names amounts in integer cents (no float math)', () => {
    const src = readFileSync(join(packageRoot, 'read-data/stripe-webhook-event-map.json'), 'utf8');
    expect(src).not.toMatch(/\bsk_(?:live|test)_/);
    expect(src).not.toMatch(/\bwhsec_/);
  });
});
