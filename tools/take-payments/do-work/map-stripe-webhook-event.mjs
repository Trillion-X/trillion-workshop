// tools/take-payments/do-work/map-stripe-webhook-event.mjs
//
// Generic Stripe-webhook-event decoder. Given a VERIFIED Stripe webhook event
// (`{ id, type, created, data: { object: {...} } }`) and the DATA map
// `data/stripe-webhook-event-map.json`, produce the GENERIC revenue PaymentEvent
// that revenue-ledger's projection consumes:
//   { event_id, occurred_at, event_kind, attributes: { ...config-keyed fields } }
//
// This is the only place that knows Stripe webhook vocabulary (L098 / no-god-
// package). revenue-ledger stays Stripe-blind — it reads `event_kind` +
// `attributes` by the customer `revenue-projection-config` paths and never learns
// "charge.refunded". Adding a new Stripe event type = a rule row in the DATA map,
// ZERO code here (L090 / enum-dissolution: the decoder enumerates nothing).
//
// Idempotency (SP4): `event_id` = the Stripe `event.id`, so re-delivery of the
// same webhook admits the same signed-event hash → the signed-event-authority
// dedupe (BTreeMap<event_id, payload_hash>) counts it once. Fail-closed: an
// event type with no rule returns null (ignored, never a guessed revenue row).
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

/** ISO-8601 from a Stripe unix `created` (seconds). The value comes from the
 *  event DATA, not a wall clock — deterministic. Empty string if absent. */
function occurredAtFrom(created) {
  if (typeof created !== 'number' || !Number.isFinite(created)) return '';
  return new Date(created * 1000).toISOString();
}

/**
 * Map a verified Stripe webhook event to a generic revenue PaymentEvent, or null
 * if no rule matches the event type (ignored / fail-closed).
 * @param {object} stripeEvent - verified Stripe event { id, type, created, data:{object} }
 * @param {object} eventMap - the stripe-webhook-event-map DATA
 * @returns {{event_id:string, occurred_at:string, event_kind:string, attributes:Record<string,unknown>}|null}
 */
export function mapStripeWebhookEvent(stripeEvent, eventMap) {
  if (!isRecord(stripeEvent) || typeof stripeEvent.type !== 'string') return null;
  const rule = ruleFor(eventMap, stripeEvent.type);
  if (!rule) return null; // unknown event type → ignored, never guessed

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
    event_id: typeof stripeEvent.id === 'string' ? stripeEvent.id : '',
    occurred_at: occurredAtFrom(stripeEvent.created),
    event_kind: rule.target_event_kind,
    attributes,
  };
}

/** Load the DATA map from disk (package-relative). */
export function loadWebhookEventMap(mapPath) {
  return JSON.parse(readFileSync(mapPath, 'utf8'));
}

