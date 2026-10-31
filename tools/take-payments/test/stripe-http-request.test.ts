// packages/stripe-payment-provider/tests/stripe-http-request.test.ts
//
// No-key contract proof for the real-charge request-construction half of #41.
// Proves the EXACT bytes we will send to Stripe — form encoding (bracket
// notation), URL, headers, idempotency, API version — and proves NO secret ever
// appears in the assembled request (auth is a credential_ref the runner resolves).
// Zero network, zero key: this is the fixture and contract proof anyone can run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from './expect.mjs';
// eslint-disable-next-line import/extensions
import { encodeStripeForm } from '../do-work/stripe-form-encode.mjs';
// eslint-disable-next-line import/extensions
import { buildStripeHttpRequest } from '../do-work/build-stripe-http-request.mjs';
// eslint-disable-next-line import/extensions

const packageRoot = join(import.meta.dirname, '..');

describe('stripe form encoder (wire format)', () => {
  it('encodes scalars, nested objects, and arrays of objects in bracket notation', () => {
    const encoded = encodeStripeForm({
      mode: 'payment',
      line_items: [{ price: 'price_launch', quantity: 1 }],
      metadata: { plan: 'launch', source: 'bakery' },
    });
    // Brackets are percent-encoded (%5B/%5D) — this is exactly what Stripe's own
    // qs-based client sends; Stripe decodes them server-side.
    expect(encoded).toBe(
      'mode=payment' +
        '&line_items%5B0%5D%5Bprice%5D=price_launch' +
        '&line_items%5B0%5D%5Bquantity%5D=1' +
        '&metadata%5Bplan%5D=launch' +
        '&metadata%5Bsource%5D=bakery',
    );
  });

  it('renders booleans as true/false and omits null/undefined', () => {
    expect(encodeStripeForm({ enabled: true, off: false, skip: null, gone: undefined, keep: '' }))
      .toBe('enabled=true&off=false&keep=');
  });

  it('percent-encodes keys and values', () => {
    expect(encodeStripeForm({ 'metadata[note]': 'a b&c=d' }))
      .toBe('metadata%5Bnote%5D=a%20b%26c%3Dd');
  });
});

describe('stripe http request assembler (no key)', () => {
  const createReq = {
    operation_id: 'operation:create-session',
    idempotency_key: 'idem_abc123',
    required_credential_ref: 'stripe-api-key',
    input_facts: {
      operation_subject: {
        id: 'checkout_attempt_1',
        mode: 'payment',
        line_items: [{ price: 'price_launch', quantity: 1 }],
        success_url: 'https://bakery.example.com/thank-you',
      },
    },
  };

  it('builds a POST create-session request with form body + idempotency + version headers', () => {
    const req = buildStripeHttpRequest(createReq);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(req.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(req.headers['Idempotency-Key']).toBe('idem_abc123');
    expect(req.headers['Stripe-Version']).toBe('2026-05-27.dahlia');
    // client_reference_id is derived from subject.id by the mapper
    expect(req.body).toContain('mode=payment');
    expect(req.body).toContain('line_items%5B0%5D%5Bprice%5D=price_launch');
    expect(req.body).toContain('client_reference_id=checkout_attempt_1');
    // The internal subject id must NOT leak to Stripe as a top-level `id` param
    // (Stripe rejects it). It is remapped to client_reference_id only.
    expect(req.body).not.toMatch(/(^|&)id=/);
  });

  it('authenticates by credential_ref only — NO secret in the assembled request', () => {
    const req = buildStripeHttpRequest(createReq);
    expect(req.auth).toEqual({ scheme: 'bearer', credential_ref: 'stripe-api-key' });
    // Authorization header is NOT materialized here (runner injects at send time).
    expect(Object.keys(req.headers)).not.toContain('Authorization');
    const serialized = JSON.stringify(req);
    expect(serialized).not.toMatch(/\bsk_(?:live|test)_/); // no secret key value ever
    expect(serialized).not.toMatch(/\brk_(?:live|test)_/);
  });

  it('builds a GET read-session request with object-ref path and no body', () => {
    const req = buildStripeHttpRequest({
      operation_id: 'operation:read-session',
      required_credential_ref: 'stripe-api-key',
      input_facts: { provider_object_ref: { ref: 'cs_test_123' } },
    });
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_test_123');
    expect(req.body).toBeUndefined();
    expect(req.headers['Content-Type']).toBeUndefined();
  });

  it('fails closed on an unsupported operation', () => {
    expect(() => buildStripeHttpRequest({ operation_id: 'operation:not-real', input_facts: {} }))
      .toThrow(/Unsupported capability operation/);
  });

  it('source carries no literal secret key', () => {
    const src = [
      readFileSync(join(packageRoot, 'do-work/build-stripe-http-request.mjs'), 'utf8'),
      readFileSync(join(packageRoot, 'do-work/stripe-form-encode.mjs'), 'utf8'),
    ].join('\n');
    expect(src).not.toMatch(/\bsk_(?:live|test)_[A-Za-z0-9]/);
    expect(src).not.toMatch(/\brk_(?:live|test)_[A-Za-z0-9]/);
  });
});

