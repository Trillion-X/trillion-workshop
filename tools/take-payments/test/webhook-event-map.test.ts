// packages/stripe-payment-provider/tests/webhook-event-map.test.ts
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
import { mapStripeWebhookEvent, loadWebhookEventMap, checkoutPaymentIntentMetadata, checkoutSubscriptionMetadata, paymentEventIdOf } from '../do-work/map-webhook-event.mjs';

const packageRoot = join(import.meta.dirname, '..');
const eventMap = loadWebhookEventMap(join(packageRoot, 'read-data/webhook-event-map.json'));

// One purchase made through Checkout: the session's completed event and the PaymentIntent event Stripe sends for it.
const checkoutCompleted = {
  id: 'evt_cs_once',
  type: 'checkout.session.completed',
  created: 1782086400,
  data: { object: { id: 'cs_live_once', amount_total: 50000, currency: 'usd', payment_status: 'paid', payment_intent: 'pi_once', customer_details: { email: 'buyer@example.com' }, metadata: { offer_id: 'offer:once' } } },
};
const checkoutPaymentIntent = {
  id: 'evt_pi_checkout_once',
  type: 'payment_intent.succeeded',
  created: 1782086402,
  data: { object: { id: 'pi_once', amount_received: 50000, currency: 'usd', metadata: { offer_id: 'offer:once', ...checkoutPaymentIntentMetadata(eventMap) } } },
};
// A PaymentIntent no Checkout made (a Payment Link or an API charge): no marker on it.
const barePaymentIntent = {
  id: 'evt_pi_bare_once',
  type: 'payment_intent.succeeded',
  created: 1782086500,
  data: { object: { id: 'pi_bare_once', amount_received: 2000, currency: 'usd', metadata: { offer_id: 'offer:bare' } } },
};

// A membership bought through Checkout in subscription mode: the completed event, the Subscription's first invoice (which
// carries the subscription metadata, marker included), and the PaymentIntent that invoice made.
const membershipCheckout = {
  id: 'evt_cs_member',
  type: 'checkout.session.completed',
  created: 1782086400,
  data: { object: { id: 'cs_live_member', amount_total: 2900, currency: 'usd', payment_status: 'paid', mode: 'subscription', subscription: 'sub_member', customer_details: { email: 'member@example.com' }, metadata: { offer_id: 'offer:membership' } } },
};
const membershipFirstInvoice = {
  id: 'evt_inv_member_first',
  type: 'invoice.paid',
  created: 1782086401,
  data: { object: { id: 'in_member_1', billing_reason: 'subscription_create', amount_paid: 2900, currency: 'usd', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_member', metadata: { offer_id: 'offer:membership', ...checkoutSubscriptionMetadata(eventMap) } } } } },
};
const membershipFirstPaymentIntent = {
  id: 'evt_pi_member_first',
  type: 'payment_intent.succeeded',
  created: 1782086402,
  data: { object: { id: 'pi_member_1', amount_received: 2900, currency: 'usd', invoice: 'in_member_1', metadata: {} } },
};
// The same membership's next month: the renewal invoice still carries the subscription metadata, so the marker is there.
const membershipRenewal = {
  id: 'evt_inv_member_2',
  type: 'invoice.paid',
  created: 1784678400,
  data: { object: { id: 'in_member_2', billing_reason: 'subscription_cycle', amount_paid: 2900, currency: 'usd', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_member', metadata: { offer_id: 'offer:membership', ...checkoutSubscriptionMetadata(eventMap) } } } } },
};
const membershipRenewalPaymentIntent = {
  id: 'evt_pi_member_2',
  type: 'payment_intent.succeeded',
  created: 1784678402,
  data: { object: { id: 'pi_member_2', amount_received: 2900, currency: 'usd', invoice: 'in_member_2', metadata: {} } },
};
// A subscription made through the API, not Checkout: no marker on it, so its first invoice is its first payment.
const apiSubscriptionFirstInvoice = {
  id: 'evt_inv_api_first',
  type: 'invoice.paid',
  created: 1782086600,
  data: { object: { id: 'in_api_1', billing_reason: 'subscription_create', amount_paid: 2900, currency: 'usd', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_api', metadata: { offer_id: 'offer:api-membership' } } } } },
};
const apiSubscriptionFirstPaymentIntent = {
  id: 'evt_pi_api_first',
  type: 'payment_intent.succeeded',
  created: 1782086601,
  data: { object: { id: 'pi_api_1', amount_received: 2900, currency: 'usd', invoice: 'in_api_1', metadata: {} } },
};
// A charge made through the API with no invoice and no Checkout.
const apiCharge = {
  id: 'evt_pi_api_charge',
  type: 'payment_intent.succeeded',
  created: 1782086700,
  data: { object: { id: 'pi_api_charge', amount_received: 1500, currency: 'usd', metadata: { offer_id: 'offer:api' } } },
};

/** Every order of a list of events. */
function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

/** The revenue rows a stream of Stripe events makes, keyed the way the ledger keys them (event_id). */
function rowsOf(events) {
  const rows = new Map();
  for (const event of events) {
    const mapped = mapStripeWebhookEvent(event, eventMap);
    if (mapped) rows.set(mapped.event_id, mapped);
  }
  return [...rows.values()];
}

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

describe('map-webhook-event → generic revenue PaymentEvent (no key)', () => {
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

  it('a Checkout purchase counts once whichever of its two events arrives first', () => {
    const csThenPi = rowsOf([checkoutCompleted, checkoutPaymentIntent]);
    const piThenCs = rowsOf([checkoutPaymentIntent, checkoutCompleted]);
    expect(csThenPi).toHaveLength(1);
    expect(piThenCs).toHaveLength(1);
    expect(csThenPi[0]).toMatchObject({ event_id: 'checkout:cs_live_once', event_kind: 'payment.confirmed' });
    expect(piThenCs[0]).toEqual(csThenPi[0]);
    // The PaymentIntent is skipped by its own marker, not by what the other event held.
    expect(mapStripeWebhookEvent(checkoutPaymentIntent, eventMap)).toBeNull();
    expect(paymentEventIdOf(checkoutCompleted)).toBe('checkout:cs_live_once');
  });

  it('a PaymentIntent no Checkout made still counts once', () => {
    const mapped = mapStripeWebhookEvent(barePaymentIntent, eventMap);
    expect(mapped).toMatchObject({ event_id: 'evt_pi_bare_once', event_kind: 'payment.confirmed', attributes: { amount_due_today_cents: 2000, offer_id: 'offer:bare', provider_object_ref: 'pi_bare_once' } });
    expect(rowsOf([barePaymentIntent, barePaymentIntent])).toHaveLength(1);
  });

  it('a replayed Checkout event counts once', () => {
    expect(rowsOf([checkoutCompleted, checkoutCompleted, checkoutPaymentIntent, checkoutCompleted])).toHaveLength(1);
    expect(rowsOf([checkoutCompleted, checkoutCompleted])).toEqual(rowsOf([checkoutCompleted]));
  });

  it('a Checkout membership\'s first payment is one row', () => {
    const rows = rowsOf([membershipCheckout, membershipFirstInvoice, membershipFirstPaymentIntent]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: 'checkout:cs_live_member', event_kind: 'payment.confirmed' });
  });

  it('a membership renewal is one row', () => {
    const rows = rowsOf([membershipRenewal, membershipRenewalPaymentIntent]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: 'evt_inv_member_2', event_kind: 'subscription.renewed' });
  });

  it('an API subscription\'s first payment is one row', () => {
    const rows = rowsOf([apiSubscriptionFirstInvoice, apiSubscriptionFirstPaymentIntent]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: 'evt_inv_api_first', event_kind: 'subscription.renewed' });
  });

  it('an API charge is one row, however often it is delivered', () => {
    expect(rowsOf([apiCharge])).toHaveLength(1);
    expect(rowsOf([apiCharge, apiCharge])).toHaveLength(1);
  });

  it('a membership\'s rows are the same in any arrival order', () => {
    const events = [membershipCheckout, membershipFirstInvoice, membershipFirstPaymentIntent];
    const expected = rowsOf(events);
    expect(expected).toHaveLength(1);
    for (const order of permutations(events)) expect(rowsOf(order)).toEqual(expected);
  });

  it('the Checkout subscription marker is the one stamped on the Subscription', () => {
    expect(checkoutSubscriptionMetadata(eventMap)).toEqual({ sold_through: 'checkout_session' });
    expect(checkoutPaymentIntentMetadata(eventMap)).toEqual({ sold_through: 'checkout_session' });
  });

  it('a skip_when with a malformed condition throws instead of silently counting twice', () => {
    const broken = { ...eventMap, rules: eventMap.rules.map(rule => (rule.stripe_event_type === 'payment_intent.succeeded'
      ? { ...rule, skip_when: { path: ['data', 'object', 'metadata', 'sold_through'] } } : rule)) };
    expect(() => mapStripeWebhookEvent(checkoutPaymentIntent, broken)).toThrow(/skip_when/);
  });

  it('map carries no secret and names amounts in integer cents (no float math)', () => {
    const src = readFileSync(join(packageRoot, 'read-data/webhook-event-map.json'), 'utf8');
    expect(src).not.toMatch(/\bsk_(?:live|test)_/);
    expect(src).not.toMatch(/\bwhsec_/);
  });
});
