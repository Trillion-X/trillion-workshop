// parts/stripe-payment-provider/process/compare-and-map-stripe-webhook.mjs
//
// Phase 2 of SP-correct Stripe webhook verification (runs AFTER the vault `sign`
// step): timing-safe compare the vault-computed expected signature against the
// header's v1 candidates, then — only on a match — decode + DATA-map the event into
// admit-ready `records[]`. No secret here either: the secret stayed in the vault;
// this module only sees the vault's returned signature (SP7).
//
// Fail-closed: the gate is an empty `records[]` (no workflow `if`) — same as the
// run-a-job runner pattern. Any reject path returns { admitted:false, reason, records:[] }.
//
// PaymentEvent shape (records[0]) = exactly what revenue-ledger projects:
//   { event_id, occurred_at, event_kind, attributes }
// revenue-ledger stays Stripe-blind (L098).

import { timingSafeEqual } from 'node:crypto';
import { mapStripeWebhookEvent } from './map-stripe-webhook-event.mjs';

/** Strip a leading `0x` (the vault `output_encoding:"hex_0x"` prefix) so the value
 *  matches Stripe's bare-hex `v1`. Lowercased for a stable compare. */
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
 * @param {string}   args.expectedSignature - the vault `sign` op result (hex, optionally `0x`-prefixed)
 * @param {string[]} args.signatures - the header's v1 candidates (Stripe sends multiple during rotation)
 * @param {string}   args.rawBody - the EXACT raw request body (the bytes that were signed)
 * @param {object}   args.eventMap - the loaded `stripe-webhook-event-map.json` DATA
 * @returns {{admitted:true,event_kind:string,records:Array<object>}|{admitted:false,reason:string,records:[]}}
 */
export function compareAndMapStripeWebhook({ expectedSignature, signatures, rawBody, eventMap } = {}) {
  const expected = normalizeHex(expectedSignature);
  if (!expected) return { admitted: false, reason: 'missing-expected-signature', records: [] };

  // Compare against EVERY provided v1 (rotation sends multiple) — timing-safe.
  const matched = Array.isArray(signatures)
    && signatures.some((candidate) => timingSafeHexEqual(normalizeHex(candidate), expected));
  if (!matched) return { admitted: false, reason: 'signature-mismatch', records: [] };

  // Signature verified — NOW decode the trusted body.
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
