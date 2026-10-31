// packages/stripe-payment-provider/tests/compare-and-map-stripe-webhook.test.ts
//
// No-key proof for Phase 2: compare the vault-computed signature + map. The test
// computes the "expected" signature the SAME way the vault would (HMAC-SHA256 over
// `${t}.${rawBody}` with a fixture secret) — simulating the vault's `sign` op
// result — so the comparator + mapper are proven end-to-end WITHOUT a real key or
// a live vault. Uses the REAL stripe-webhook-event-map.json DATA.
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from './expect.mjs';
// eslint-disable-next-line import/extensions
import { compareAndMapStripeWebhook } from '../do-work/compare-and-map-stripe-webhook.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENT_MAP = JSON.parse(readFileSync(join(HERE, '../read-data/stripe-webhook-event-map.json'), 'utf8'));

const SECRET = 'whsec_fixture_secret';
const T = 1782086400;

const RAW = JSON.stringify({
  id: 'evt_checkout_1',
  type: 'checkout.session.completed',
  created: T,
  data: { object: {
    id: 'cs_1',
    amount_total: 2950,
    client_reference_id: 'attempt-1',
    currency: 'usd',
    payment_status: 'paid',
    subscription_status: 'active',
    metadata: {
      cadence: 'one_time',
      offer_id: 'premium-membership',
      price_option_id: 'price:support',
      validated_amount_cents: '2950',
    },
  } },
});

/** What the vault `sign` op (hmac_sha256, key_encoding raw, output hex) returns. */
function vaultSign(rawBody: string): string {
  return createHmac('sha256', SECRET).update(`${T}.${rawBody}`).digest('hex');
}

describe('compare-and-map-stripe-webhook (Phase 2, no key)', () => {
  it('admits when the vault signature matches a v1, and maps to a PaymentEvent', () => {
    const expected = vaultSign(RAW);
    const r = compareAndMapStripeWebhook({
      expectedSignature: expected, signatures: ['deadbeef', expected], rawBody: RAW, eventMap: EVENT_MAP,
    });
    expect(r.admitted).toBe(true);
    expect(r.event_kind).toBe('payment.confirmed');
    expect(r.records[0].event_id).toBe('evt_checkout_1');
    expect(r.records[0].attributes).toMatchObject({ amount_due_today_cents: 2950, currency: 'usd', offer_id: 'premium-membership' });
    expect(r.records[0].attributes).toMatchObject({
      cadence: 'one_time',
      checkout_attempt_id: 'attempt-1',
      payment_status: 'paid',
      price_option_id: 'price:support',
      validated_amount_cents: '2950',
    });
  });

  it('normalizes the vault `0x` hex prefix before comparing', () => {
    const expected = vaultSign(RAW);
    const r = compareAndMapStripeWebhook({
      expectedSignature: `0x${expected}`, signatures: [expected], rawBody: RAW, eventMap: EVENT_MAP,
    });
    expect(r.admitted).toBe(true);
  });

  it('fail-closed: no v1 matches the vault signature → signature-mismatch (no record)', () => {
    const r = compareAndMapStripeWebhook({
      expectedSignature: vaultSign(RAW), signatures: ['00'.repeat(32)], rawBody: RAW, eventMap: EVENT_MAP,
    });
    expect(r).toEqual({ admitted: false, reason: 'signature-mismatch', records: [] });
  });

  it('fail-closed: empty/absent vault signature → missing-expected-signature', () => {
    expect(compareAndMapStripeWebhook({ expectedSignature: '', signatures: ['x'], rawBody: RAW, eventMap: EVENT_MAP }))
      .toEqual({ admitted: false, reason: 'missing-expected-signature', records: [] });
  });

  it('fail-closed: verified signature but unmapped event type → unmapped-event-type', () => {
    const raw = JSON.stringify({ id: 'evt_x', type: 'customer.created', created: T, data: { object: {} } });
    const r = compareAndMapStripeWebhook({
      expectedSignature: vaultSign(raw), signatures: [vaultSign(raw)], rawBody: raw, eventMap: EVENT_MAP,
    });
    expect(r).toEqual({ admitted: false, reason: 'unmapped-event-type', records: [] });
  });

  it('fail-closed: verified signature but malformed JSON → malformed-json', () => {
    const raw = '{not json';
    const r = compareAndMapStripeWebhook({
      expectedSignature: vaultSign(raw), signatures: [vaultSign(raw)], rawBody: raw, eventMap: EVENT_MAP,
    });
    expect(r).toEqual({ admitted: false, reason: 'malformed-json', records: [] });
  });

  it('refund event maps to payment.refunded with the refunded amount', () => {
    const raw = JSON.stringify({ id: 'evt_r', type: 'charge.refunded', created: T, data: { object: { id: 'ch_1', amount_refunded: 2950, currency: 'usd', metadata: { offer_id: 'premium-membership' } } } });
    const r = compareAndMapStripeWebhook({
      expectedSignature: vaultSign(raw), signatures: [vaultSign(raw)], rawBody: raw, eventMap: EVENT_MAP,
    });
    expect(r.admitted).toBe(true);
    expect(r.event_kind).toBe('payment.refunded');
    expect(r.records[0].attributes.amount_due_today_cents).toBe(2950);
  });
});
