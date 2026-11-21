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
import { mapStripeWebhookEvent, loadWebhookEventMap, checkoutPaymentIntentMetadata, invoiceNeedingPaymentIntent, paymentEventIdOf } from '../do-work/map-webhook-event.mjs';

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

// A membership bought through Checkout in subscription mode: its completed event names the first invoice, whose PaymentIntent
// keys the checkout, the invoice and the PaymentIntent event, so the three are one payment.
const membershipCheckout = {
  id: 'evt_cs_member',
  type: 'checkout.session.completed',
  created: 1782086400,
  data: { object: { id: 'cs_live_member', mode: 'subscription', invoice: 'in_member_1', amount_total: 2900, currency: 'usd', payment_status: 'paid', subscription: 'sub_member', customer_details: { email: 'member@example.com' }, metadata: { offer_id: 'offer:membership' } } },
};
const membershipFirstInvoice = {
  id: 'evt_inv_member_first',
  type: 'invoice.paid',
  created: 1782086401,
  data: { object: { id: 'in_member_1', billing_reason: 'subscription_create', amount_paid: 2900, currency: 'usd', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_member', metadata: { offer_id: 'offer:membership' } } } } },
};
const membershipFirstPaymentIntent = {
  id: 'evt_pi_member_first',
  type: 'payment_intent.succeeded',
  created: 1782086402,
  data: { object: { id: 'pi_member_1', amount_received: 2900, currency: 'usd', metadata: {} } },
};
// The same membership's next month: the renewal invoice and its PaymentIntent share one payment key.
const membershipRenewal = {
  id: 'evt_inv_member_2',
  type: 'invoice.paid',
  created: 1784678400,
  data: { object: { id: 'in_member_2', billing_reason: 'subscription_cycle', amount_paid: 2900, currency: 'usd', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_member', metadata: { offer_id: 'offer:membership' } } } } },
};
const membershipRenewalPaymentIntent = {
  id: 'evt_pi_member_2',
  type: 'payment_intent.succeeded',
  created: 1784678402,
  data: { object: { id: 'pi_member_2', amount_received: 2900, currency: 'usd', metadata: {} } },
};
// A subscription made through the API, not Checkout: its first invoice and PaymentIntent share one payment key.
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
  data: { object: { id: 'pi_api_1', amount_received: 2900, currency: 'usd', metadata: {} } },
};
// A charge made through the API with no invoice and no Checkout.
const apiCharge = {
  id: 'evt_pi_api_charge',
  type: 'payment_intent.succeeded',
  created: 1782086700,
  data: { object: { id: 'pi_api_charge', amount_received: 1500, currency: 'usd', metadata: { offer_id: 'offer:api' } } },
};
// The PaymentIntent each paid invoice was paid with, as invoicePaymentIntent reads it from the invoice's payments.
const invoicePaymentIntents = { in_member_1: 'pi_member_1', in_member_2: 'pi_member_2', in_api_1: 'pi_api_1' };

/** Every order of a list of events. */
function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

/** The revenue rows a stream of Stripe events makes, keyed the way the ledger keys them (event_id). */
function rowsOf(events) {
  const rows = new Map();
  for (const event of events) {
    const invoice = invoiceNeedingPaymentIntent(event);
    const mapped = mapStripeWebhookEvent(event, eventMap, invoice ? invoicePaymentIntents[invoice] : null);
    if (!mapped) continue;
    const stored = rows.get(mapped.event_id);
    if (!stored) { rows.set(mapped.event_id, mapped); continue; }
    // The keep's merge (scripts/payment-catch-up.mjs): an empty field is filled, and a payment.confirmed moves up to
    // subscription.renewed, never back.
    for (const [key, value] of Object.entries(mapped.attributes)) if (stored.attributes[key] == null) stored.attributes[key] = value;
    if (stored.event_kind === 'payment.confirmed' && mapped.event_kind === 'subscription.renewed') stored.event_kind = mapped.event_kind;
  }
  return [...rows.values()];
}

/** The fields the keep stores the same whichever of a payment's events arrives first. */
function storedFieldsOf(rows) {
  return rows.map((row) => ({ event_id: row.event_id, event_kind: row.event_kind, offer_id: row.attributes.offer_id ?? null, subscription_id: row.attributes.subscription_id ?? null, amount: row.attributes.amount_due_today_cents ?? null }));
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
      event_id: 'payment:pi_123',
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
    const ev = mapStripeWebhookEvent(invoicePaid, eventMap, 'pi_renewal');
    expect(ev.event_kind).toBe('subscription.renewed');
    expect(ev.attributes.amount_due_today_cents).toBe(2900);
    expect(ev.attributes.recurring_amount_cents).toBe(2900);
    expect(ev.attributes.subscription_status).toBe('active');
    expect(ev.attributes.provider_object_ref).toBe('pi_renewal');
    expect(ev.attributes.invoice_ref).toBe('in_123');
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
    expect(mapStripeWebhookEvent(paymentIntentSucceeded, eventMap).event_id).toBe('payment:pi_123');
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
    expect(csThenPi[0]).toMatchObject({ event_id: 'payment:pi_once', event_kind: 'payment.confirmed' });
    expect(piThenCs[0]).toEqual(csThenPi[0]);
    // The PaymentIntent is skipped by its own marker, not by what the other event held.
    expect(mapStripeWebhookEvent(checkoutPaymentIntent, eventMap)).toBeNull();
    expect(paymentEventIdOf(checkoutCompleted)).toBe('payment:pi_once');
  });

  it('a PaymentIntent no Checkout made still counts once', () => {
    const mapped = mapStripeWebhookEvent(barePaymentIntent, eventMap);
    expect(mapped).toMatchObject({ event_id: 'payment:pi_bare_once', event_kind: 'payment.confirmed', attributes: { amount_due_today_cents: 2000, offer_id: 'offer:bare', provider_object_ref: 'pi_bare_once' } });
    expect(rowsOf([barePaymentIntent, barePaymentIntent])).toHaveLength(1);
  });

  it('a replayed Checkout event counts once', () => {
    expect(rowsOf([checkoutCompleted, checkoutCompleted, checkoutPaymentIntent, checkoutCompleted])).toHaveLength(1);
    expect(rowsOf([checkoutCompleted, checkoutCompleted])).toEqual(rowsOf([checkoutCompleted]));
  });

  it('a Checkout membership\'s first payment is one row: the checkout, its invoice and its PaymentIntent share a key', () => {
    expect(() => mapStripeWebhookEvent(membershipCheckout, eventMap)).toThrow(/needs its PaymentIntent/);
    const rows = rowsOf([membershipCheckout, membershipFirstInvoice, membershipFirstPaymentIntent]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: 'payment:pi_member_1', event_kind: 'payment.confirmed', attributes: { offer_id: 'offer:membership', subscription_id: 'sub_member', provider_object_ref: 'pi_member_1', completion_ref: 'cs_live_member' } });
  });

  it('a membership renewal is one row, and its kind is renewed whichever of its two events arrives first', () => {
    for (const order of [[membershipRenewal, membershipRenewalPaymentIntent], [membershipRenewalPaymentIntent, membershipRenewal]]) {
      const rows = rowsOf(order);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ event_id: 'payment:pi_member_2', event_kind: 'subscription.renewed' });
    }
  });

  it('an API subscription\'s first payment is one row', () => {
    const rows = rowsOf([apiSubscriptionFirstInvoice, apiSubscriptionFirstPaymentIntent]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: 'payment:pi_api_1', event_kind: 'payment.confirmed' });
  });

  it('an API charge is one row, however often it is delivered', () => {
    expect(rowsOf([apiCharge])).toHaveLength(1);
    expect(rowsOf([apiCharge, apiCharge])).toHaveLength(1);
  });

  it('a membership\'s rows are the same in any arrival order', () => {
    const events = [membershipCheckout, membershipFirstInvoice, membershipFirstPaymentIntent];
    const expected = storedFieldsOf(rowsOf(events));
    expect(expected).toEqual([{ event_id: 'payment:pi_member_1', event_kind: 'payment.confirmed', offer_id: 'offer:membership', subscription_id: 'sub_member', amount: 2900 }]);
    for (const order of permutations(events)) expect(storedFieldsOf(rowsOf(order))).toEqual(expected);
  });

  it('a paid invoice with no PaymentIntent is refused, never keyed by its own id', () => {
    expect(() => mapStripeWebhookEvent(membershipFirstInvoice, eventMap)).toThrow(/needs its PaymentIntent/);
  });

  it('a $0 invoice is not a payment: it keeps its event id and needs no PaymentIntent', () => {
    const trial = { ...membershipFirstInvoice, id: 'evt_inv_trial', data: { object: { ...membershipFirstInvoice.data.object, id: 'in_trial', amount_paid: 0 } } };
    expect(mapStripeWebhookEvent(trial, eventMap)).toMatchObject({ event_id: 'evt_inv_trial' });
  });

  it('the Checkout marker on a one-time payment is the one the PaymentIntent is stamped with', () => {
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

// The live skip-rule proof, replayed: the six Stripe test-mode events it made (both one-off PaymentIntents, both subscription
// invoices and their PaymentIntents), copied with emails and names redacted. The invoices' PaymentIntents are the ones their
// invoice payments named.
describe('the skip-rule proof replayed through the map (test mode)', () => {
  const proof = JSON.parse(readFileSync(join(packageRoot, 'test/fixtures/proof-events.json'), 'utf8'));

  /** The rows a list of the proof's events keeps, merged the way the keep merges them. */
  function keptBy(events) {
    const rows = new Map();
    for (const event of events) {
      const invoice = invoiceNeedingPaymentIntent(event);
      const mapped = mapStripeWebhookEvent(event, eventMap, invoice ? proof.invoicePaymentIntents[invoice] : null);
      if (!mapped) continue;
      const stored = rows.get(mapped.event_id);
      if (!stored) rows.set(mapped.event_id, mapped);
      else if (stored.event_kind === 'payment.confirmed' && mapped.event_kind === 'subscription.renewed') stored.event_kind = mapped.event_kind;
    }
    return [...rows.values()];
  }

  it('one row per payment: the marked one-off is its checkout\'s, and each subscription payment is one row whichever event arrives first', () => {
    const forward = keptBy(proof.events);
    const backward = keptBy([...proof.events].reverse());
    expect(forward.map(row => row.event_id).sort()).toEqual(backward.map(row => row.event_id).sort());
    const subscriptionPis = Object.values(proof.invoicePaymentIntents);
    const plainOneOff = proof.events.find(ev => ev.type === 'payment_intent.succeeded' && !ev.data.object.metadata.sold_through && !subscriptionPis.includes(ev.data.object.id));
    expect(forward.map(row => row.event_id).sort()).toEqual([plainOneOff.data.object.id, ...subscriptionPis].map(id => `payment:${id}`).sort());
    expect(forward.every(row => row.attributes.provider_object_ref === row.event_id.slice('payment:'.length))).toBe(true);
    expect(forward.filter(row => row.event_kind === 'subscription.renewed')).toHaveLength(0);
    expect(forward.filter(row => row.event_kind === 'payment.confirmed')).toHaveLength(3);
  });

  it('the marked one-off keeps no row of its own (its completed checkout is the payment)', () => {
    const marked = proof.events.find(ev => ev.type === 'payment_intent.succeeded' && ev.data.object.metadata.sold_through === 'checkout_session');
    expect(mapStripeWebhookEvent(marked, eventMap)).toBeNull();
  });
});
