// The signed-service-calls leaf with made-up secrets and calls: two different signing rows (a payment service's
// "t=,v1=" header in hex, and the standard webhook headers in base64 over id.timestamp.body) checked by the same code,
// a forged or stale call refused and told to nobody, each change told under its own key, and a 503 when the engine
// does not take the fact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { changesOf, checkSignature, describeMechanism, watchForTransitions } from '../do-work/mechanisms/signed-service-calls.mjs';

const NOW = 1795050000;
const HEX_ROW = {
  parts: { t: { header: 'Payment-Signature', match: '(?:^|,)t=(\\d+)' }, v1: { header: 'Payment-Signature', match: '(?:^|,)v1=([0-9a-f]+)' } },
  signed: '{t}.{body}', signature: 'v1', hash: 'sha256', encoding: 'hex', timestamp: 't', tolerance_seconds: 300,
};
const STANDARD_ROW = {
  parts: { id: { header: 'webhook-id' }, ts: { header: 'webhook-timestamp' }, sig: { header: 'webhook-signature', match: '(?:^| )v1,([A-Za-z0-9+/=]+)' } },
  signed: '{id}.{ts}.{body}', signature: 'sig', hash: 'sha256', encoding: 'base64', secret_prefix: 'whsec_', secret_encoding: 'base64', timestamp: 'ts', tolerance_seconds: 300,
};
const HEX_SECRET = 'made-up-signing-secret';
const STANDARD_SECRET = `whsec_${Buffer.from('made-up-standard-key').toString('base64')}`;
const paymentBody = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', created: NOW - 5, data: { object: { id: 'in_7', amount_paid: 4900 }, previous_attributes: { status: 'open' } } });
const hexHeaders = (body, t = NOW, secret = HEX_SECRET) => ({ 'payment-signature': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}` });
const standardHeaders = (body, ts = NOW) => {
  const key = Buffer.from(STANDARD_SECRET.slice('whsec_'.length), 'base64');
  return { 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64')}` };
};

test('it declares the fact fields every change carries', () => {
  assert.deepEqual(describeMechanism().detail_fields, ['where', 'place', 'change', 'at', 'key', 'before', 'after']);
});

test('two services that sign differently are checked by their rows, not by code', () => {
  assert.deepEqual(checkSignature({ verify: HEX_ROW, headers: hexHeaders(paymentBody), body: paymentBody, secret: HEX_SECRET, nowSeconds: NOW }), { ok: true });
  const envelope = JSON.stringify({ id: 'msg_1', metadata: { trigger_slug: 'NEW_MESSAGE' }, data: { message_id: 'm_9' } });
  assert.deepEqual(checkSignature({ verify: STANDARD_ROW, headers: standardHeaders(envelope), body: envelope, secret: STANDARD_SECRET, nowSeconds: NOW }), { ok: true });
});

test('a forged, altered, stale or unsigned call is refused', () => {
  const check = (headers, body = paymentBody, nowSeconds = NOW) => checkSignature({ verify: HEX_ROW, headers, body, secret: HEX_SECRET, nowSeconds }).reason;
  assert.equal(check(hexHeaders(paymentBody, NOW, 'someone-else')), 'signature-mismatch');
  assert.equal(check(hexHeaders(paymentBody), paymentBody.replace('4900', '1')), 'signature-mismatch');
  assert.equal(check(hexHeaders(paymentBody, NOW - 301)), 'outside-replay-window');
  assert.equal(check({}), 'no-signature');
  assert.equal(checkSignature({ verify: { ...HEX_ROW, hash: 'md5' }, headers: hexHeaders(paymentBody), body: paymentBody, secret: HEX_SECRET, nowSeconds: NOW }).reason, 'unknown-hash');
});

test('a verified call becomes changes by its shape row: place, change, key, when, before and after', () => {
  const shape = { place: { value: 'invoice' }, change: { path: 'type', map: { 'invoice.paid': 'changed', 'invoice.created': 'added' } }, key: 'data.object.id', at: 'created', at_unit: 'seconds', before: 'data.previous_attributes', after: 'data.object' };
  const { changes } = changesOf({ shape, where: 'my-payments', body: paymentBody });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].detail, { where: 'my-payments', place: 'invoice', change: 'changed', at: new Date((NOW - 5) * 1000).toISOString(), key: 'in_7', before: '{"status":"open"}', after: '{"id":"in_7","amount_paid":4900}' });
  assert.equal(changesOf({ shape, where: 'x', body: '{"type":"something.else","data":{"object":{"id":"1"}}}' }).refused, 'change-not-in-shape');
  assert.equal(changesOf({ shape, where: 'x', body: 'not json' }).refused, 'body-is-not-json');
});

test('one call kind carrying several kinds of thing reads its place and change through maps (the booking service row)', () => {
  const shape = { place: { path: 'type', map: { 'booking.created': 'booking', 'booking.cancelled': 'booking', 'payment.completed': 'payment' } },
    change: { path: 'type', map: { 'booking.created': 'added', 'booking.cancelled': 'changed', 'payment.completed': 'added' } }, key: 'data.id', at: 'created_at', at_unit: 'iso' };
  const body = JSON.stringify({ id: 'e-1', type: 'booking.cancelled', created_at: '2026-11-18T21:00:00+00:00', data: { id: 77, cancelled_at: '2026-11-18T21:00:00Z' } });
  const { changes } = changesOf({ shape, where: 'my-booking-service', body });
  assert.deepEqual([changes[0].detail.place, changes[0].detail.change, changes[0].detail.key, changes[0].detail.at], ['booking', 'changed', '77', '2026-11-18T21:00:00.000Z']);
});

async function post(port, headers, body) {
  return new Promise((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'application/json', ...headers } }, (response) => {
      let text = ''; response.on('data', (chunk) => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    call.on('error', reject); call.end(body);
  });
}

test('over HTTP: a good call is told and answered 200, a forged one 401 and told to nobody, an untaken fact 503', async () => {
  const told = [];
  let take = true;
  const control = new AbortController();
  let port;
  const ready = new Promise((resolve) => {
    watchForTransitions({ where: 'my-payments', verify: HEX_ROW, shape: { place: { value: 'invoice' }, change: { path: 'type', map: { 'invoice.paid': 'changed' } }, key: 'data.object.id', at: 'created' } }, {
      secret: HEX_SECRET, now: () => NOW * 1000, signal: control.signal, listening: (address) => { port = address.port; resolve(); },
      onTransition: async (transition) => { if (!take) return false; told.push(transition); return true; },
    });
  });
  await ready;
  assert.equal((await post(port, hexHeaders(paymentBody), paymentBody)).status, 200);
  assert.equal(told.length, 1);
  assert.equal(told[0].detail.key, 'in_7');
  assert.equal((await post(port, hexHeaders(paymentBody, NOW, 'forged'), paymentBody)).status, 401);
  assert.equal(told.length, 1);
  take = false;
  assert.equal((await post(port, hexHeaders(paymentBody), paymentBody)).status, 503);
  control.abort();
});
