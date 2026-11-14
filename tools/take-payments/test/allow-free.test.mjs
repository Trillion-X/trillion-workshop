// tools/take-payments/test/allow-free.test.mjs
// A voluntary-amount policy lets a buyer pick 0 (free) unless it says `allow_free: false`: a paid membership with a
// minimum price must not be had for nothing by choosing 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceASale } from '../do-work/take-payments.mjs';

const offer = extra => ({
  kind: 'commercial-offer', id: 'offer:member', label: 'Member', access_refs: ['access:member'],
  price_options: [{
    id: 'price:member', label: 'Monthly', amount_cents: 5000, currency: 'usd', interval: 'month', payment_timing: 'recurring',
    voluntary_amount_policy: { allow_custom: true, currency: 'usd', min_cents: 5000, suggested_cents: [5000, 10000], ...extra },
  }],
});
const ask = (amount, extra) => priceASale({
  offerId: 'offer:member', priceOptionId: 'price:member', checkoutAttemptId: 'synthetic-attempt-0001', checkoutStartedAt: '2026-11-14T04:00:00Z',
  customerSelectedAmountCents: amount, offers: [offer(extra)], adjustments: [],
}, {});

test('a policy that says nothing about free still lets a buyer pick 0', async () => {
  assert.equal((await ask(0, {})).quote.amountDueTodayCents, '0');
});

test('allow_free false refuses 0 and keeps the minimum and larger amounts', async () => {
  await assert.rejects(ask(0, { allow_free: false }), /at least 5000 usd/);
  await assert.rejects(ask(100, { allow_free: false }), /at least 5000 usd/);
  assert.equal((await ask(5000, { allow_free: false })).quote.amountDueTodayCents, '5000');
  assert.equal((await ask(12000, { allow_free: false })).quote.amountDueTodayCents, '12000');
});

test('allow_free must be true or false', async () => {
  await assert.rejects(ask(5000, { allow_free: 'no' }), /allow_free must be boolean/);
});
