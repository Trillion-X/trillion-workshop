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
// succeeded event). A rule's `skip_when` drops the event when it holds (see skipWhenHolds). A one-time Checkout's
// PaymentIntent is skipped by the marker `checkoutPaymentIntentMetadata` returns; a PaymentIntent an invoice made is
// skipped because the invoice counts that payment; a subscription's first invoice that a Checkout made is skipped by
// the marker `checkoutSubscriptionMetadata` returns, because the Checkout's completed event counts that payment. A bare
// PaymentIntent and an API subscription's first invoice carry no marker and count.
// The decision reads only the one event, so the result does not depend on which of the events arrives first.
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

/** One skip condition holds when the event's value at its path is exactly `equals`, or, with `present: true`, when a
 *  value is there. A malformed condition throws: a skip that silently never applies would count a purchase twice. */
function conditionHolds(stripeEvent, condition) {
  if (!Array.isArray(condition?.path)) throw new Error('webhook-event-map: skip_when needs a path array.');
  if (condition.present === true) return getPath(stripeEvent, condition.path) != null;
  if (typeof condition.equals !== 'string') throw new Error('webhook-event-map: skip_when needs a text equals or present: true.');
  return getPath(stripeEvent, condition.path) === condition.equals;
}

/** A `skip_when` is one condition, a list (any one holds), or { all_of: [...] } (every one holds); groups nest. */
function skipWhenHolds(stripeEvent, skipWhen) {
  if (skipWhen === undefined) return false;
  if (Array.isArray(skipWhen)) return skipWhen.some((item) => skipWhenHolds(stripeEvent, item));
  if (Array.isArray(skipWhen.all_of)) return skipWhen.all_of.every((item) => skipWhenHolds(stripeEvent, item));
  return conditionHolds(stripeEvent, skipWhen);
}

/** Every single condition a `skip_when` names, whatever its shape. */
function conditionsIn(skipWhen) {
  if (skipWhen === undefined) return [];
  if (Array.isArray(skipWhen)) return skipWhen.flatMap(conditionsIn);
  if (Array.isArray(skipWhen.all_of)) return skipWhen.all_of.flatMap(conditionsIn);
  return [skipWhen];
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

/** The one marker a rule's skip condition reads at `prefix` (a path to a metadata object), as the metadata to stamp. */
function markerAt(eventMap, stripeEventType, prefix, failure) {
  const found = conditionsIn(ruleFor(eventMap, stripeEventType)?.skip_when).filter((condition) => Array.isArray(condition.path)
    && condition.path.length === prefix.length + 1 && prefix.every((segment, index) => condition.path[index] === segment)
    && typeof condition.equals === 'string');
  if (found.length !== 1) throw new Error(failure);
  return { [found[0].path.at(-1)]: found[0].equals };
}

/**
 * The PaymentIntent metadata every one-time Checkout stamps on the PaymentIntent it makes, so the mapper skips that
 * PaymentIntent (its rule's skip_when). It is read from that rule, so the DATA map is the one place the marker is
 * written: a session builder that stamps anything else would count its purchase twice again.
 */
export function checkoutPaymentIntentMetadata(eventMap) {
  return markerAt(eventMap, 'payment_intent.succeeded', ['data', 'object', 'metadata'],
    'webhook-event-map: payment_intent.succeeded needs skip_when at data.object.metadata.<key> with a text equals.');
}

/**
 * The subscription metadata a Checkout in subscription mode stamps on the Subscription it makes. Stripe copies it onto
 * that subscription's first invoice (parent.subscription_details.metadata), where the invoice.paid rule's skip_when
 * reads it, so the Checkout's completed event is the one row for that first payment. An API subscription has no marker
 * and its first invoice counts.
 */
export function checkoutSubscriptionMetadata(eventMap) {
  return markerAt(eventMap, 'invoice.paid', ['data', 'object', 'parent', 'subscription_details', 'metadata'],
    'webhook-event-map: invoice.paid needs skip_when at data.object.parent.subscription_details.metadata.<key> with a text equals.');
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

