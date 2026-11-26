// tools/take-payments/do-work/map-webhook-event.mjs
//
// Generic Stripe-webhook-event decoder. Given a VERIFIED Stripe webhook event
// (`{ id, type, created, data: { object: {...} } }`) and the DATA map
// `data/webhook-event-map.json`, produce the GENERIC revenue PaymentEvent
// that revenue-ledger's projection consumes:
//   { event_id, occurred_at, event_kind, attributes: { ...config-keyed fields } }
//
// This is the only place that knows Stripe webhook vocabulary (L098 / no-god-
// package). revenue-ledger stays Stripe-blind — it reads `event_kind` +
// `attributes` by the customer `revenue-projection-config` paths and never learns
// "charge.refunded". Adding a new Stripe event type = a rule row in the DATA map,
// ZERO code here (L090 / enum-dissolution: the decoder enumerates nothing).
//
// One payment, one row. Every event that is a row of one payment is named by that payment's PaymentIntent
// (`payment:<pi id>`): the PaymentIntent's own event, a one-time Checkout's completed event (its session's PaymentIntent),
// and a paid invoice's event (the PaymentIntent the invoice was paid with, read by invoicePaymentIntent, because the
// invoice does not name it). Stripe sends several events for one payment, so they share one key and the keep (payment
// events, by id) takes the payment once whichever arrives first. An event with no PaymentIntent (a $0 invoice, a setup
// checkout) keeps its Stripe event id. Re-delivery of the same event gives the same id.
// Fail-closed: an event type with no rule returns null (ignored, never a guessed revenue row), and a paid invoice with no
// PaymentIntent is refused rather than keyed by its own id, which would count the payment twice.
//
// A rule's `skip_when` drops an event whose value at its path is exactly `equals`. Two rules use it: a one-time
// Checkout's PaymentIntent (stamped with the marker `checkoutPaymentIntentMetadata` returns, so the completed session is
// the row) and a subscription Checkout's completed event (its PaymentIntent comes from the invoice, which is the row).
//
// Pure function, zero I/O, zero secrets, zero network — fixture-provable with no
// key. Signature verification is a SEPARATE upstream step
// (capability:stripe.webhook.verify-and-observe); this decoder runs only on an
// already-verified event.

import { readFileSync } from 'node:fs';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Resolve a dotted path (array of keys) against a nested object; undefined if
 *  any segment is missing. */
function getPath(root, path) {
  let cursor = root;
  for (const key of path) {
    if (!isRecord(cursor) && !Array.isArray(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function ruleFor(eventMap, stripeEventType) {
  const rules = Array.isArray(eventMap?.rules) ? eventMap.rules : [];
  return rules.find((rule) => rule.stripe_event_type === stripeEventType);
}

/** A rule's `skip_when` holds when the event's value at its path is exactly `equals`. A malformed condition throws:
 *  a skip that silently never applies would count a purchase twice. */
function skipWhenHolds(stripeEvent, condition) {
  if (condition === undefined) return false;
  if (!Array.isArray(condition?.path) || typeof condition.equals !== 'string') {
    throw new Error('webhook-event-map: skip_when needs a path array and a text equals.');
  }
  return getPath(stripeEvent, condition.path) === condition.equals;
}

/** ISO-8601 from a Stripe unix `created` (seconds). The value comes from the
 *  event DATA, not a wall clock — deterministic. Empty string if absent. */
function occurredAtFrom(created) {
  if (typeof created !== 'number' || !Number.isFinite(created)) return '';
  return new Date(created * 1000).toISOString();
}

/**
 * The invoice whose PaymentIntent the caller must read before this event can be keyed: a paid invoice's own (amount above
 * zero), and a subscription Checkout's first invoice (a Checkout that charged nothing has none). Null when no read is needed.
 */
export function invoiceNeedingPaymentIntent(stripeEvent) {
  const object = stripeEvent?.data?.object;
  if (stripeEvent?.type === 'invoice.paid' && Number(object?.amount_paid) > 0) return object.id;
  if (stripeEvent?.type === 'checkout.session.completed' && object?.mode === 'subscription' && Number(object?.amount_total) > 0
    && typeof object?.invoice === 'string' && object.invoice && !object.payment_intent) return object.invoice;
  return null;
}

/**
 * The Stripe event types that are a payment's own events, so their row is named by the payment's PaymentIntent. The
 * kinds the event map keeps them as are a payment's kinds (paymentKindsOf in payment-keys.ts), which the store's
 * one-row-per-payment keys are drawn over.
 */
export const PAYMENT_EVENT_TYPES = Object.freeze([
  'payment_intent.succeeded',
  'invoice.paid',
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

/**
 * The PaymentIntent a Stripe event's payment is named by, or null when the event names none. A paid invoice's, and a
 * subscription Checkout's, come from the caller's read (`paymentIntent`), because those events do not carry it.
 */
export function paymentIntentOf(stripeEvent, paymentIntent = null) {
  if (!PAYMENT_EVENT_TYPES.includes(stripeEvent.type)) return null;
  const object = stripeEvent.data?.object;
  if (stripeEvent.type === 'payment_intent.succeeded') return typeof object?.id === 'string' && object.id ? object.id : null;
  if (stripeEvent.type === 'invoice.paid') return typeof paymentIntent === 'string' && paymentIntent ? paymentIntent : null;
  if (stripeEvent.type === 'checkout.session.completed' || stripeEvent.type === 'checkout.session.async_payment_succeeded') {
    if (typeof object?.payment_intent === 'string' && object.payment_intent) return object.payment_intent;
    return typeof paymentIntent === 'string' && paymentIntent ? paymentIntent : null;
  }
  return null;
}

/**
 * The id a Stripe event's payment row is named by: `payment:<PaymentIntent id>` when the event belongs to a payment, its
 * Stripe event id otherwise (a completed checkout without one keeps its checkout session's id). Rows written before this
 * key keep their ids.
 */
export function paymentEventIdOf(stripeEvent, paymentIntent = null) {
  const key = paymentIntentOf(stripeEvent, paymentIntent);
  if (key) return `payment:${key}`;
  const sessionId = stripeEvent.data?.object?.id;
  if (stripeEvent.type === 'checkout.session.completed' && typeof sessionId === 'string' && sessionId) return `checkout:${sessionId}`;
  return typeof stripeEvent.id === 'string' ? stripeEvent.id : '';
}

/**
 * The payment kind an event is, from its own facts: a rule's `target_event_kind_by_billing_reason` names the kind for an
 * invoice's billing reason (a first subscription invoice is the first payment), and `target_event_kind` is the rest.
 */
function eventKindOf(stripeEvent, rule) {
  const byReason = rule.target_event_kind_by_billing_reason ?? {};
  const reason = stripeEvent.data?.object?.billing_reason;
  return (typeof reason === 'string' && byReason[reason]) || rule.target_event_kind;
}

/**
 * Map a verified Stripe webhook event to a generic revenue PaymentEvent, or null
 * if no rule matches the event type (ignored / fail-closed).
 * @param {object} stripeEvent - verified Stripe event { id, type, created, data:{object} }
 * @param {object} eventMap - the webhook-event-map DATA
 * @param {string|null} [paymentIntent] - the PaymentIntent of a paid invoice, read from its payments (invoicePaymentIntent)
 * @returns {{event_id:string, occurred_at:string, event_kind:string, attributes:Record<string,unknown>}|null}
 */
export function mapStripeWebhookEvent(stripeEvent, eventMap, paymentIntent = null) {
  if (!isRecord(stripeEvent) || typeof stripeEvent.type !== 'string') return null;
  const rule = ruleFor(eventMap, stripeEvent.type);
  if (!rule) return null; // unknown event type → ignored, never guessed
  if (skipWhenHolds(stripeEvent, rule.skip_when)) return null; // the one-time Checkout's PaymentIntent: its completed session is the payment
  if (invoiceNeedingPaymentIntent(stripeEvent) && !paymentIntent) {
    throw new Error(`webhook-event-map: ${stripeEvent.type} ${stripeEvent.data?.object?.id} needs its PaymentIntent before it is mapped.`);
  }

  const attributes = {};
  for (const [canonicalKey, source] of Object.entries(rule.attribute_map || {})) {
    if (source && Object.prototype.hasOwnProperty.call(source, 'literal')) {
      attributes[canonicalKey] = source.literal;
      continue;
    }
    if (source && Array.isArray(source.path)) {
      const value = getPath(stripeEvent, source.path);
      if (value !== undefined && value !== null) attributes[canonicalKey] = value;
    }
  }
  // Every row of one payment refers to it by its PaymentIntent, so the stored reference does not depend on which of the
  // payment's events arrived first (the checkout session stays in completion_ref, the invoice in invoice_ref).
  const key = paymentIntentOf(stripeEvent, paymentIntent);
  if (key) attributes.provider_object_ref = key;
  // Provenance the revenue/audit trail always carries.
  attributes.provider_event_id = stripeEvent.id;

  return {
    event_id: paymentEventIdOf(stripeEvent, paymentIntent),
    occurred_at: occurredAtFrom(stripeEvent.created),
    event_kind: eventKindOf(stripeEvent, rule),
    attributes,
  };
}

/**
 * The PaymentIntent metadata every one-time Checkout stamps on the PaymentIntent it makes, so the mapper skips that
 * PaymentIntent (its rule's skip_when). It is read from that rule, so the DATA map is the one place the marker is
 * written: a session builder that stamps anything else would count its purchase twice again.
 */
export function checkoutPaymentIntentMetadata(eventMap) {
  const condition = ruleFor(eventMap, 'payment_intent.succeeded')?.skip_when;
  const path = condition?.path;
  if (!Array.isArray(path) || path.length !== 4 || path[0] !== 'data' || path[1] !== 'object' || path[2] !== 'metadata'
    || typeof condition.equals !== 'string') {
    throw new Error('webhook-event-map: payment_intent.succeeded needs skip_when at data.object.metadata.<key> with a text equals.');
  }
  return { [path[3]]: condition.equals };
}

/** Load the DATA map from disk (package-relative). */
export function loadWebhookEventMap(mapPath) {
  return JSON.parse(readFileSync(mapPath, 'utf8'));
}

/**
 * The payment row a mapped Stripe event becomes, named by its payment key. Every path that reads a Stripe event
 * (the webhook check, the event listing, the checkout list) builds its row here, so one payment is one row whichever way
 * it arrives.
 */
export function paymentEventNamedBy(mapped) {
  return { kind: 'payment-event', id: `payment-event:${mapped.event_id}`, ...mapped };
}
