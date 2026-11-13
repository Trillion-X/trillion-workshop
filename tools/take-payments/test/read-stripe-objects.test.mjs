// tools/take-payments/test/read-stripe-objects.test.mjs
//
// A read of Stripe's promotion codes, with a stand-in Stripe: the query is the one the row's DATA builds, each thing
// comes back in the row's shape only, nothing but GET ever leaves, a key is never answered, a live key is refused by
// the test-mode sibling before anything is built, and the reader's code names no provider, address or field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { call } from '../do-work/build-stripe-http-request.mjs';
import { readOnly, readStripeObjects, project, StripeReadError } from '../do-work/read-stripe-objects.mjs';
import { readStripePromotionCodes, readStripePromotionCodesInTestMode } from '../do-work/take-payments.mjs';
import operationMap from '../read-data/stripe-operation-map.json' with { type: 'json' };
import readShapes from '../read-data/stripe-read-shapes.json' with { type: 'json' };

const promotionCode = {
  id: 'promo_sample0001',
  object: 'promotion_code',
  code: 'SAMPLEFRIEND25',
  active: true,
  times_redeemed: 3,
  max_redemptions: 100,
  expires_at: 1893456000,
  customer: 'cus_must_not_leak',
  restrictions: { first_time_transaction: true, minimum_amount: 500, minimum_amount_currency: 'usd' },
  promotion: {
    type: 'coupon',
    coupon: {
      id: 'coupon_sample0001', object: 'coupon', name: 'Sample friend discount', amount_off: null, percent_off: 25, currency: null,
      duration: 'repeating', duration_in_months: 3, valid: true, times_redeemed: 3, max_redemptions: null, redeem_by: null, metadata: { note: 'must-not-leak' },
    },
  },
};
const asRead = {
  id: 'promo_sample0001', code: 'SAMPLEFRIEND25', active: true, times_redeemed: 3, max_redemptions: 100, expires_at: 1893456000,
  restrictions: { first_time_transaction: true, minimum_amount: 500, currency: 'usd' },
  coupon: {
    id: 'coupon_sample0001', name: 'Sample friend discount', amount_off: null, percent_off: 25, currency: null, duration: 'repeating',
    duration_in_months: 3, valid: true, times_redeemed: 3, max_redemptions: null, redeem_by: null,
  },
};

function stripeStandIn(reply = { object: 'list', data: [promotionCode], has_more: false }) {
  const sent = [];
  return { sent, send: async request => { sent.push(request); return reply; } };
}

test('reads one code with its coupon expanded, in the row\'s shape and nothing more', async () => {
  const { sent, send } = stripeStandIn();
  const answer = await readStripeObjects('read:promotion-codes', { code: 'SAMPLEFRIEND25' }, { send });
  assert.deepEqual(answer, { promotion_codes: [asRead], has_more: false });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'GET');
  assert.equal(sent[0].url, 'https://api.stripe.com/v1/promotion_codes?code=SAMPLEFRIEND25&expand%5B0%5D=data.promotion.coupon');
  assert.equal(sent[0].body, undefined);
  assert.doesNotMatch(JSON.stringify(answer), /must-not-leak|cus_/);
});

test('active and limit become query words, in the row\'s order, and false is kept', async () => {
  const { sent, send } = stripeStandIn({ data: [], has_more: true });
  const answer = await readStripeObjects('read:promotion-codes', { limit: 5, active: false }, { send });
  assert.deepEqual(answer, { promotion_codes: [], has_more: true });
  assert.equal(sent[0].url, 'https://api.stripe.com/v1/promotion_codes?active=false&limit=5&expand%5B0%5D=data.promotion.coupon');
});

test('a coupon at the older place is read, and a coupon Stripe sent only as an id answers null', () => {
  const shape = readShapes.reads[0].shape;
  const older = { ...promotionCode, promotion: undefined, coupon: promotionCode.promotion.coupon };
  assert.deepEqual(project(older, shape), asRead);
  assert.equal(project({ ...promotionCode, promotion: { type: 'coupon', coupon: 'coupon_sample0001' } }, shape).coupon, null);
});

test('a field Stripe did not send answers null, never a guess', () => {
  assert.deepEqual(project({ id: 'promo_x' }, readShapes.reads[0].shape).restrictions, { first_time_transaction: null, minimum_amount: null, currency: null });
});

test('refuses an input the row does not name, or of the wrong kind or range, before any request is sent', async () => {
  const { sent, send } = stripeStandIn();
  for (const input of [{ coupon: 'x' }, { code: 7 }, { active: 'true' }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }]) {
    await assert.rejects(readStripeObjects('read:promotion-codes', input, { send }), StripeReadError);
  }
  await assert.rejects(readStripeObjects('read:nothing', {}, { send }), /no read named/);
  assert.equal(sent.length, 0);
});

test('refuses a reply that is not a list', async () => {
  await assert.rejects(readStripeObjects('read:promotion-codes', {}, { send: stripeStandIn({ id: 'promo_x' }).send }), /no list/);
});

test('the sender is wrapped so that any request that is not a GET is refused before it leaves', async () => {
  const { sent, send } = stripeStandIn();
  for (const operation of ['operation:create-coupon', 'operation:create-promotion-code', 'operation:update-promotion-code']) {
    await assert.rejects(call(readOnly(send), operation, { name: 'x' }, { ref: 'promo_x' }), /GET requests only/);
  }
  assert.equal(sent.length, 0);
});

test('every read row names a GET operation of the operation map, and an input the tool row also names', () => {
  const rows = JSON.parse(readFileSync(fileURLToPath(new URL('../tool-rows.json', import.meta.url)), 'utf8')).records.map(record => record.payload ?? record);
  for (const read of readShapes.reads) {
    const operation = operationMap.operations.find(candidate => candidate.operation_id === read.operation_id);
    assert.equal(operation?.method, 'GET', `${read.read_id} must be a GET operation`);
  }
  for (const id of ['tool:read-stripe-promotion-codes', 'tool:read-stripe-promotion-codes-in-test-mode']) {
    const row = rows.find(candidate => candidate.id === id);
    assert.deepEqual(Object.keys(row.input_schema.properties).sort(), Object.keys(readShapes.reads[0].inputs).sort(), id);
    assert.equal(row.invoke.credential_mounts.length, 1);
  }
});

test('the reader\'s code names no provider address, id shape or field', () => {
  const code = readFileSync(fileURLToPath(new URL('../do-work/read-stripe-objects.mjs', import.meta.url)), 'utf8').replace(/^\/\/.*$/gm, '');
  assert.doesNotMatch(code, /stripe\.com|https?:|promo|coupon|sub_|cus_|_test_|expires|redeem/i);
});

const liveKey = 'sk_live_made_up_sample_key';
const testKey = 'sk_test_made_up_sample_key';
const held = key => descriptor => { assert.equal(descriptor, 4); return `${key}\n`; };

function fetchStandIn({ status = 200, body = { data: [promotionCode], has_more: false } } = {}) {
  const sent = [];
  return { sent, fetchImpl: async (url, init) => { sent.push({ url, ...init }); return { status, text: async () => JSON.stringify(body) }; } };
}

test('the key goes on the Authorization header of the one GET and is never answered', async () => {
  const { sent, fetchImpl } = fetchStandIn();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const answer = await readStripePromotionCodes({ code: 'SAMPLEFRIEND25' }, { readKey: held(liveKey) });
    assert.deepEqual(answer.promotion_codes, [asRead]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'GET');
    assert.equal(sent[0].headers.Authorization, `Bearer ${liveKey}`);
    assert.doesNotMatch(JSON.stringify(answer), /sk_live|made_up_sample_key/);
  } finally { globalThis.fetch = realFetch; }
});

test('a refusal from Stripe is said without the key', async () => {
  const { fetchImpl } = fetchStandIn({ status: 401, body: { error: { message: `Invalid API Key provided: ${liveKey}` } } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await assert.rejects(readStripePromotionCodes({}, { readKey: held(liveKey) }), error => { assert.doesNotMatch(error.message, /made_up_sample_key/); return true; });
  } finally { globalThis.fetch = realFetch; }
});

test('the test-mode read refuses a live key before any request is built, and reads with a test key', async () => {
  const { sent, send } = stripeStandIn();
  await assert.rejects(readStripePromotionCodesInTestMode({}, { readKey: held(liveKey), send }), /not a Stripe test key/);
  assert.equal(sent.length, 0);
  const answer = await readStripePromotionCodesInTestMode({ active: true }, { readKey: held(testKey), send });
  assert.deepEqual(answer.promotion_codes, [asRead]);
  assert.equal(sent.length, 1);
});
