// tools/take-payments/do-work/compare-and-map-stripe-webhook.mjs
//
// Second half of checking a Stripe webhook: timing-safe compare the signature computed with the person's signing
// secret against the header's v1 candidates, then, only on a match, decode and DATA-map the event into admit-ready
// `records[]` (a PaymentEvent each: { event_id, occurred_at, event_kind, attributes }, exactly what the revenue tools
// read, which stay blind to Stripe).
//
// Fail-closed: the gate is an empty `records[]`. Any reject path returns { admitted:false, reason, records:[] }.
//
// `admitStripeWebhook` is the whole check in one call: parse (tolerance window), sign with the secret, compare, map.
// The secret is used for one HMAC and goes no further: it is never returned, logged or placed in a reason.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { mapStripeWebhookEvent } from './map-stripe-webhook-event.mjs';
import { parseStripeSignature } from './parse-stripe-signature.mjs';

/** Strip a leading `0x` so the value matches Stripe's bare-hex `v1`. Lowercased for a stable compare. */
function normalizeHex(value) {
  if (typeof value !== 'string') return '';
  const lower = value.toLowerCase();
  return lower.startsWith('0x') ? lower.slice(2) : lower;
}

/** Constant-time hex compare (decode to bytes; mismatched length / bad hex → false). */
function timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * @param {object} args
 * @param {string}   args.expectedSignature the signature computed with the signing secret (hex, optionally `0x`-prefixed)
 * @param {string[]} args.signatures the header's v1 candidates (Stripe sends several during a secret rotation)
 * @param {string}   args.rawBody the EXACT raw request body (the bytes that were signed)
 * @param {object}   args.eventMap the loaded `stripe-webhook-event-map.json` DATA
 * @returns {{admitted:true,event_kind:string,records:Array<object>}|{admitted:false,reason:string,records:[]}}
 */
export function compareAndMapStripeWebhook({ expectedSignature, signatures, rawBody, eventMap } = {}) {
  const expected = normalizeHex(expectedSignature);
  if (!expected) return { admitted: false, reason: 'missing-expected-signature', records: [] };

  // Compare against EVERY provided v1 (rotation sends several), timing-safe.
  const matched = Array.isArray(signatures)
    && signatures.some((candidate) => timingSafeHexEqual(normalizeHex(candidate), expected));
  if (!matched) return { admitted: false, reason: 'signature-mismatch', records: [] };

  // Signature verified: only now decode the trusted body.
  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch {
    return { admitted: false, reason: 'malformed-json', records: [] };
  }

  const mapped = mapStripeWebhookEvent(stripeEvent, eventMap);
  if (!mapped) return { admitted: false, reason: 'unmapped-event-type', records: [] };

  return { admitted: true, event_kind: mapped.event_kind, records: [mapped] };
}

/**
 * Check a webhook the way Stripe documents it and map it to payment events.
 * @param {{ payload: string, header: string, secret: string, eventMap: object, toleranceSeconds?: number, nowSeconds?: number }} args
 */
export function admitStripeWebhook({ payload, header, secret, eventMap, toleranceSeconds, nowSeconds }) {
  if (typeof secret !== 'string' || !secret) return { admitted: false, reason: 'missing-signing-secret', records: [] };
  const parsed = parseStripeSignature({ payload, header, toleranceSeconds, nowSeconds });
  if (!parsed.ok) return { admitted: false, reason: parsed.reason, records: [] };
  const expectedSignature = createHmac('sha256', secret).update(parsed.message, 'utf8').digest('hex');
  return compareAndMapStripeWebhook({ expectedSignature, signatures: parsed.signatures, rawBody: payload, eventMap });
}
