// tools/take-payments/do-work/admit-a-webhook.mjs
//
// Second half of checking a Stripe webhook: timing-safe compare the signature computed with the person's signing
// secret against the header's v1 candidates, then, only on a match, decode the event and DATA-map it into admit-ready
// `records[]` (a PaymentEvent each: { event_id, occurred_at, event_kind, attributes }, exactly what the revenue tools
// read, which stay blind to Stripe).
//
// Fail-closed: the gate is an empty `records[]`. Any reject path returns { admitted:false, reason, records:[] }.
//
// A paid invoice is mapped only with the PaymentIntent it was paid with, which the caller reads (invoicePaymentIntent)
// after the signature is verified, so no Stripe read is made for a forged event. `verifyStripeWebhookSignature` is that
// first step; `compareAndMapStripeWebhook` is the same compare and map for a caller that already has the PaymentIntent.
// The secret is used for one HMAC and goes no further: it is never returned, logged or placed in a reason.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { mapStripeWebhookEvent } from './map-webhook-event.mjs';
import { parseStripeSignature } from './parse-webhook-signature.mjs';

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
 * Compare the expected signature with the header's candidates, and only on a match decode the body.
 * @param {object} args
 * @param {string}   args.expectedSignature the signature computed with the signing secret (hex, optionally `0x`-prefixed)
 * @param {string[]} args.signatures the header's v1 candidates (Stripe sends several during a secret rotation)
 * @param {string}   args.rawBody the EXACT raw request body (the bytes that were signed)
 * @returns {{admitted:true,stripeEvent:object}|{admitted:false,reason:string,stripeEvent:null}}
 */
function compareSignature({ expectedSignature, signatures, rawBody }) {
  const expected = normalizeHex(expectedSignature);
  if (!expected) return { admitted: false, reason: 'missing-expected-signature', stripeEvent: null };

  // Compare against EVERY provided v1 (rotation sends several), timing-safe.
  const matched = Array.isArray(signatures)
    && signatures.some((candidate) => timingSafeHexEqual(normalizeHex(candidate), expected));
  if (!matched) return { admitted: false, reason: 'signature-mismatch', stripeEvent: null };

  // Signature verified: only now decode the trusted body.
  try {
    return { admitted: true, stripeEvent: JSON.parse(rawBody) };
  } catch {
    return { admitted: false, reason: 'malformed-json', stripeEvent: null };
  }
}

/**
 * Check a webhook's signature the way Stripe documents it (parse with the tolerance window, sign with the secret, compare)
 * and decode the event. Nothing is mapped here.
 * @param {{ payload: string, header: string, secret: string, toleranceSeconds?: number, nowSeconds?: number }} args
 * @returns {{admitted:true,stripeEvent:object}|{admitted:false,reason:string,stripeEvent:null}}
 */
export function verifyStripeWebhookSignature({ payload, header, secret, toleranceSeconds, nowSeconds }) {
  if (typeof secret !== 'string' || !secret) return { admitted: false, reason: 'missing-signing-secret', stripeEvent: null };
  const parsed = parseStripeSignature({ payload, header, toleranceSeconds, nowSeconds });
  if (!parsed.ok) return { admitted: false, reason: parsed.reason, stripeEvent: null };
  const expectedSignature = createHmac('sha256', secret).update(parsed.message, 'utf8').digest('hex');
  return compareSignature({ expectedSignature, signatures: parsed.signatures, rawBody: payload });
}

/**
 * @param {object} args
 * @param {string}   args.expectedSignature the signature computed with the signing secret (hex, optionally `0x`-prefixed)
 * @param {string[]} args.signatures the header's v1 candidates
 * @param {string}   args.rawBody the EXACT raw request body (the bytes that were signed)
 * @param {object}   args.eventMap the loaded `webhook-event-map.json` DATA
 * @param {string|null} [args.paymentIntent] the PaymentIntent of a paid invoice, read by the caller
 * @returns {{admitted:true,event_kind:string,records:Array<object>}|{admitted:false,reason:string,records:[]}}
 */
export function compareAndMapStripeWebhook({ expectedSignature, signatures, rawBody, eventMap, paymentIntent = null } = {}) {
  const checked = compareSignature({ expectedSignature, signatures, rawBody });
  if (!checked.admitted) return { admitted: false, reason: checked.reason, records: [] };

  let mapped;
  try {
    mapped = mapStripeWebhookEvent(checked.stripeEvent, eventMap, paymentIntent);
  } catch {
    return { admitted: false, reason: 'payment-intent-unresolved', records: [] };
  }
  if (!mapped) return { admitted: false, reason: 'unmapped-event-type', records: [] };

  return { admitted: true, event_kind: mapped.event_kind, records: [mapped] };
}
