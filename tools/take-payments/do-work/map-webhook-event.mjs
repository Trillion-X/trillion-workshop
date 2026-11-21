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
// Idempotency (SP4): `event_id` is the Stripe `event.id`, except a completed checkout, which is named by its
// checkout session (`checkout:<cs id>`, see paymentEventIdOf). Re-delivery of the same webhook, or the same checkout
// read from a list, gives the same event_id, so the signed-event-authority dedupe (BTreeMap<event_id, payload_hash>)
// counts it once. Fail-closed: an
// event type with no rule returns null (ignored, never a guessed revenue row).
//
// One purchase, one row (Stripe sends a Checkout purchase twice: the session's completed event and its PaymentIntent's
// succeeded event). A rule's `skip_when` ({ path, equals }) drops the event whose value at that path is exactly
// `equals`. The payment_intent.succeeded rule skips the PaymentIntent a Checkout made, because Checkout stamps that
// PaymentIntent with the marker `checkoutPaymentIntentMetadata` returns. A bare PaymentIntent has no marker and counts.
// The decision reads only the one event, so the result does not depend on which of the two arrives first.
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
 * The id a completed checkout's payment row is named by. The webhook, the event list and the checkout list all name a
 * checkout through this one function, so the same checkout is the same row whichever way it arrives.
 */
export function checkoutEventIdOf(sessionId) {
  return `checkout:${sessionId}`;
}

/**
 * The id a Stripe event's payment row is named by: a completed checkout by its checkout session, every other kind by
 * its Stripe event id. A checkout reached by webhook and by either list has one row, not one per path.
 */
export function paymentEventIdOf(stripeEvent) {
  const sessionId = stripeEvent.data?.object?.id;
  if (stripeEvent.type === 'checkout.session.completed' && typeof sessionId === 'string' && sessionId) {
    return checkoutEventIdOf(sessionId);
  }
  return typeof stripeEvent.id === 'string' ? stripeEvent.id : '';
}

/**
 * Map a verified Stripe webhook event to a generic revenue PaymentEvent, or null
 * if no rule matches the event type (ignored / fail-closed).
 * @param {object} stripeEvent - verified Stripe event { id, type, created, data:{object} }
 * @param {object} eventMap - the webhook-event-map DATA
 * @returns {{event_id:string, occurred_at:string, event_kind:string, attributes:Record<string,unknown>}|null}
 */
export function mapStripeWebhookEvent(stripeEvent, eventMap) {
  if (!isRecord(stripeEvent) || typeof stripeEvent.type !== 'string') return null;
  const rule = ruleFor(eventMap, stripeEvent.type);
  if (!rule) return null; // unknown event type → ignored, never guessed
  if (skipWhenHolds(stripeEvent, rule.skip_when)) return null; // the Checkout that made this PaymentIntent is the payment

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
  // Provenance the revenue/audit trail always carries.
  attributes.provider_event_id = stripeEvent.id;

  return {
    event_id: paymentEventIdOf(stripeEvent),
    occurred_at: occurredAtFrom(stripeEvent.created),
    event_kind: rule.target_event_kind,
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
 * The payment row a mapped Stripe event becomes, named by the Stripe event id. Every path that reads a Stripe event
 * (the webhook check, the event listing) builds its row here, so one event is one row whichever way it arrives.
 */
export function paymentEventNamedBy(mapped) {
  return { kind: 'payment-event', id: `payment-event:${mapped.event_id}`, ...mapped };
}

