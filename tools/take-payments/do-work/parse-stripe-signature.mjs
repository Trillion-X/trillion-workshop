// tools/take-payments/do-work/parse-stripe-signature.mjs
//
// First half of checking a Stripe webhook: parse the `Stripe-Signature` header, enforce the timestamp-tolerance replay
// window, and build the EXACT signed message. It touches no secret; `compare-and-map-stripe-webhook.mjs` applies the
// person's signing secret and decides.
//
// Stripe scheme (https://docs.stripe.com/webhooks#verify-manually):
//   Header `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]`
//   signed_payload = `${t}.${raw_request_body}`   (exact raw bytes, never re-serialized)
//   expected = HMAC-SHA256(signed_payload, webhook_secret) as hex
//   valid iff any v1 == expected (timing-safe) AND |now - t| <= tolerance.
//
// Pure and deterministic: `nowSeconds` is injected (default = wall clock) so the tolerance check can be tested.
// Fail-closed: every error path returns { ok:false, reason }, never throws past the boundary, never "valid by default".

const DEFAULT_TOLERANCE_SECONDS = 300; // Stripe's recommended 5-minute replay window

/** Parse `t=...,v1=...,v1=...` → { timestamp, signatures[] }. */
function splitSignatureHeader(header) {
  const result = { timestamp: '', signatures: [] };
  if (typeof header !== 'string') return result;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') result.timestamp = value;
    else if (key === 'v1') result.signatures.push(value);
  }
  return result;
}

/**
 * Parse + tolerance-check + build the to-be-signed message. No secret, no HMAC.
 * @param {object} args
 * @param {string} args.payload the RAW request body as received (exact string; never re-serialize)
 * @param {string} args.header the `Stripe-Signature` header value
 * @param {number} [args.toleranceSeconds=300] max allowed |now - t|
 * @param {number} [args.nowSeconds] current unix seconds (injected for determinism; defaults to wall clock)
 * @returns {{ok:true,timestamp:number,signatures:string[],message:string,messageB64:string}|{ok:false,reason:string}}
 */
export function parseStripeSignature({ payload, header, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, nowSeconds } = {}) {
  if (typeof payload !== 'string') return { ok: false, reason: 'missing-payload' };

  const { timestamp, signatures } = splitSignatureHeader(header);
  if (!timestamp || signatures.length === 0) return { ok: false, reason: 'malformed-signature-header' };

  const t = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(t)) return { ok: false, reason: 'invalid-timestamp' };

  const now = typeof nowSeconds === 'number' && Number.isFinite(nowSeconds)
    ? nowSeconds
    : Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSeconds) return { ok: false, reason: 'timestamp-outside-tolerance' };

  // The exact bytes the signing secret is applied to.
  const message = `${timestamp}.${payload}`;
  return {
    ok: true,
    timestamp: t,
    signatures,
    message,
    messageB64: Buffer.from(message, 'utf8').toString('base64'),
  };
}
