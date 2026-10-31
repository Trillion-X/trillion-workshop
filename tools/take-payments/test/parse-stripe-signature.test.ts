// packages/stripe-payment-provider/tests/parse-stripe-signature.test.ts
//
// No-key proof for Phase 1 of SP-correct verification: header parse + tolerance +
// message build. No secret involved (the HMAC is the vault's job).
import { describe, expect, it } from './expect.mjs';
// eslint-disable-next-line import/extensions
import { parseStripeSignature } from '../do-work/parse-stripe-signature.mjs';

const T = 1782086400; // 2026-06-22T00:00:00.000Z
const PAYLOAD = '{"id":"evt_1","type":"checkout.session.completed"}';

describe('parse-stripe-signature (Phase 1, no key)', () => {
  it('parses a valid header within tolerance and builds the exact signed message', () => {
    const r = parseStripeSignature({
      payload: PAYLOAD, header: `t=${T},v1=abc,v1=def`, nowSeconds: T + 10,
    });
    expect(r.ok).toBe(true);
    expect(r.timestamp).toBe(T);
    expect(r.signatures).toEqual(['abc', 'def']);
    expect(r.message).toBe(`${T}.${PAYLOAD}`);
    // messageB64 decodes back to the exact `${t}.${payload}` the vault must HMAC.
    expect(Buffer.from(r.messageB64, 'base64').toString('utf8')).toBe(`${T}.${PAYLOAD}`);
  });

  it('fail-closed: non-string payload → missing-payload', () => {
    expect(parseStripeSignature({ header: `t=${T},v1=x`, nowSeconds: T }))
      .toEqual({ ok: false, reason: 'missing-payload' });
  });

  it('fail-closed: malformed header (no t / no v1) → malformed-signature-header', () => {
    expect(parseStripeSignature({ payload: PAYLOAD, header: 'garbage', nowSeconds: T }).reason)
      .toBe('malformed-signature-header');
    expect(parseStripeSignature({ payload: PAYLOAD, header: `t=${T}`, nowSeconds: T }).reason)
      .toBe('malformed-signature-header');
  });

  it('fail-closed: non-numeric timestamp → invalid-timestamp', () => {
    expect(parseStripeSignature({ payload: PAYLOAD, header: 't=notanumber,v1=x', nowSeconds: T }).reason)
      .toBe('invalid-timestamp');
  });

  it('fail-closed: stale timestamp (replay) → timestamp-outside-tolerance', () => {
    expect(parseStripeSignature({ payload: PAYLOAD, header: `t=${T},v1=x`, nowSeconds: T + 400 }).reason)
      .toBe('timestamp-outside-tolerance');
  });
});
