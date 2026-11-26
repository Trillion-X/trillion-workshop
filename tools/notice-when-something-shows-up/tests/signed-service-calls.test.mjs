// The signed-service-calls leaf with made-up secrets and calls: two different signing rows (a payment service's
// "t=,v1=" header in hex, and the standard webhook headers in base64 over id.timestamp.body) checked by the same code,
// a forged or stale call refused and told to nobody, each change told under its own key, and a 503 when the engine
// does not take the fact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { changesOf, checkSignature, describeMechanism, signingRuleNamed, watchForTransitions } from '../do-work/mechanisms/signed-service-calls.mjs';

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

// The signing rules in signing-rules.json, checked against the vectors each service publishes. Twilio's vectors are the
// ones its own SDK tests use (token 12345, the url with its query, five form fields); the engine's Rust check uses them too.
const TWILIO_URL = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const TWILIO_TOKEN = '12345';
const TWILIO_BODY = 'CallSid=CA1234567890ABCDE&Digits=1234&From=%2B14158675309&To=%2B18005551212&Caller=%2B14158675309';
const twilioCheck = (body, signature, { url = TWILIO_URL, secret = TWILIO_TOKEN } = {}) =>
  checkSignature({ verify: signingRuleNamed('twilio-request-signature'), headers: { 'x-twilio-signature': signature }, body, secret, nowSeconds: NOW, url }).reason ?? 'ok';

test("Twilio's published request signature is accepted under its rule; an altered field, url or token is refused", () => {
  assert.equal(twilioCheck(TWILIO_BODY, 'RSOYDt4T1cUTdK1PDd93/VVr8B8='), 'ok');
  assert.equal(twilioCheck(TWILIO_BODY.replace('Digits=1234', 'Digits=9999'), 'RSOYDt4T1cUTdK1PDd93/VVr8B8='), 'signature-mismatch');
  assert.equal(twilioCheck(TWILIO_BODY, 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', { url: 'https://mycompany.com/other' }), 'signature-mismatch');
  assert.equal(twilioCheck(TWILIO_BODY, 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', { secret: 'wrong-token' }), 'signature-mismatch');
  assert.equal(twilioCheck(TWILIO_BODY, 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', { url: null }), 'missing-signed-part',
    'a row that is not given its declared url refuses the call rather than signing a partial string');
});

test('Twilio signs the url with or without its default port: the either rule accepts both, exact only the declared url', () => {
  assert.equal(twilioCheck(TWILIO_BODY, 'kvajT1Ptam85bY51eRf/AJRuM3w='), 'ok');
  assert.equal(twilioCheck(TWILIO_BODY, '0ZXoZLH/DfblKGATFgpif+LLRf4=', { url: TWILIO_URL.replace('https', 'http') }), 'ok');
  assert.equal(twilioCheck(TWILIO_BODY, 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', { url: 'https://mycompany.com:1234/myapp.php?foo=1&bar=2' }), 'ok');
  const exact = { ...signingRuleNamed('twilio-request-signature'), url_ports: 'exact' };
  assert.equal(checkSignature({ verify: exact, headers: { 'x-twilio-signature': 'kvajT1Ptam85bY51eRf/AJRuM3w=' }, body: TWILIO_BODY, secret: TWILIO_TOKEN, nowSeconds: NOW, url: TWILIO_URL }).reason,
    'signature-mismatch');
});

test('a repeated Twilio form field is signed once per distinct value; an unknown form or url_ports option is refused', () => {
  assert.equal(twilioCheck('Sid=CA123&SidAccount=AC123&Digits=5678&Digits=1234&Digits=1234', 'IK+Dwps556ElfBT0I3Rgjkr1wJU='), 'ok');
  const headers = { 'x-twilio-signature': 'IK+Dwps556ElfBT0I3Rgjkr1wJU=' };
  const rule = signingRuleNamed('twilio-request-signature');
  assert.equal(checkSignature({ verify: { ...rule, form: 'bogus' }, headers, body: 'Sid=CA123', secret: TWILIO_TOKEN, nowSeconds: NOW, url: TWILIO_URL }).reason, 'unknown-form');
  assert.equal(checkSignature({ verify: { ...rule, url_ports: 'most' }, headers, body: 'Sid=CA123', secret: TWILIO_TOKEN, nowSeconds: NOW, url: TWILIO_URL }).reason, 'unknown-url-ports');
});

test('the stripe-signature rule accepts a Stripe-signed call; a stale or untimed one is refused; the same call told twice keeps one event key', () => {
  const rule = signingRuleNamed('stripe-signature');
  // Stripe's HMAC key is the whole endpoint secret, its whsec_ prefix included (the live take-payments check does the same).
  const STRIPE_SECRET = `whsec_${HEX_SECRET}`;
  const check = (headers, nowSeconds = NOW) => checkSignature({ verify: rule, headers, body: paymentBody, secret: STRIPE_SECRET, nowSeconds }).reason ?? 'ok';
  const stripeHeaders = (t) => ({ 'stripe-signature': `t=${t},v1=${createHmac('sha256', STRIPE_SECRET).update(`${t}.${paymentBody}`).digest('hex')}` });
  assert.equal(check(stripeHeaders(NOW)), 'ok');
  assert.equal(check(stripeHeaders(NOW - 301)), 'outside-replay-window');
  // The signed text includes {t}, so a call without its timestamp is refused before its clock is read (the Rust check's order).
  assert.equal(check({ 'stripe-signature': `v1=${createHmac('sha256', STRIPE_SECRET).update(`${NOW}.${paymentBody}`).digest('hex')}` }), 'missing-signed-part');
  assert.equal(check(stripeHeaders(NOW)), 'ok', 'the call that names its timestamp is accepted');
  assert.equal(checkSignature({ verify: rule, headers: stripeHeaders(NOW), body: paymentBody, secret: HEX_SECRET, nowSeconds: NOW }).reason, 'signature-mismatch',
    'the key without its whsec_ prefix does not verify a Stripe call');
  const shape = { place: { value: 'invoice' }, change: { path: 'type', map: { 'invoice.paid': 'changed' } }, key: 'data.object.id', at: 'created', at_unit: 'seconds' };
  const first = changesOf({ shape, where: 'my-payments', body: paymentBody }).changes[0].event_key;
  assert.equal(changesOf({ shape, where: 'my-payments', body: paymentBody }).changes[0].event_key, first, 'a replayed call names the same fact');
});

test('the standard-webhooks rule accepts a call signed under the standard headers and refuses one signed with another key', () => {
  const envelope = JSON.stringify({ id: 'msg_1', metadata: { trigger_slug: 'NEW_MESSAGE' }, data: { message_id: 'm_9' } });
  const rule = signingRuleNamed('standard-webhooks');
  assert.deepEqual(checkSignature({ verify: rule, headers: standardHeaders(envelope), body: envelope, secret: STANDARD_SECRET, nowSeconds: NOW }), { ok: true });
  const otherKey = `whsec_${Buffer.from('some-other-key').toString('base64')}`;
  assert.equal(checkSignature({ verify: rule, headers: standardHeaders(envelope), body: envelope, secret: otherKey, nowSeconds: NOW }).reason, 'signature-mismatch');
});

test('a waiter that names an unknown rule, a verify key it cannot read, or a malformed reply is refused when it starts', async () => {
  const base = { where: 'x', shape: { place: { value: 'x' }, change: { path: 'type', map: {} }, key: 'id', at: 'created' } };
  const handlers = { secret: HEX_SECRET, signal: new AbortController().signal, onTransition: async () => true };
  await assert.rejects(watchForTransitions({ ...base, verify: 'made-up-service' }, handlers), { reason: 'unknown-signing-rule' });
  await assert.rejects(watchForTransitions({ ...base, verify: { ...HEX_ROW, scheme: 'made-up' } }, handlers), { reason: 'unknown-verify-key' });
  await assert.rejects(watchForTransitions({ ...base, verify: HEX_ROW, reply: { content_type: 'text/xml' } }, handlers), { reason: 'bad-reply-row' });
});

async function postRaw(port, headers, body) {
  return new Promise((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } }, (response) => {
      let text = ''; response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'], body: text }));
    });
    call.on('error', reject); call.end(body);
  });
}

test('over HTTP: a Twilio call signed under its rule is answered with the row reply, a forged one is refused with the row status', async () => {
  const told = [];
  const control = new AbortController();
  const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thanks.</Say></Response>';
  let port;
  const ready = new Promise((resolve) => {
    watchForTransitions({ where: 'my-calls', verify: 'twilio-request-signature', url: TWILIO_URL, refusal_status: 403, reply: { content_type: 'text/xml; charset=utf-8', body: twiml },
      shape: { place: { value: 'call' }, change: { path: 'type', map: { x: 'added' } }, key: 'CallSid', at: 'created' } }, {
      secret: TWILIO_TOKEN, now: () => NOW * 1000, signal: control.signal, listening: (address) => { port = address.port; resolve(); },
      onTransition: async (transition) => { told.push(transition); return true; },
    });
  });
  await ready;
  const signed = await postRaw(port, { 'x-twilio-signature': 'RSOYDt4T1cUTdK1PDd93/VVr8B8=' }, TWILIO_BODY);
  assert.deepEqual([signed.status, signed.type, signed.body], [200, 'text/xml; charset=utf-8', twiml]);
  // A Twilio call is a form, not JSON, so the shape cannot read it yet: it is kept as one "unread" fact, as any unreadable call is.
  assert.deepEqual([told.length, told[0].detail.place, told[0].detail.key], [1, 'unread', 'body-is-not-json']);
  const forged = await postRaw(port, { 'x-twilio-signature': 'kvajT1Ptam85bY51eRf/AJRuM3w=' }, TWILIO_BODY.replace('Digits=1234', 'Digits=0'));
  assert.deepEqual([forged.status, JSON.parse(forged.body).reason], [403, 'signature-mismatch']);
  assert.equal(told.length, 1, 'a forged call is told to nobody');
  control.abort();
});

test('the sign-in-tool-call rule accepts the sign-in tool\'s after-sign-up call and reads it as one person added; a stale, altered or re-encoded one is refused', () => {
  const rule = signingRuleNamed('sign-in-tool-call');
  const secret = 'made-up-sign-in-call-secret';
  const body = JSON.stringify({ user_id: 'u-41', email: 'new@example.test', made_at: '2026-11-25T21:00:00.000Z', cookies: { site_ref: 'FRIEND-7K3Q' } });
  const headers = (t = NOW, text = body) => ({ 'x-sign-in-timestamp': String(t), 'x-sign-in-signature': `sha256=${createHmac('sha256', secret).update(`${t}.${text}`).digest('hex')}` });
  const check = (given, text = body, nowSeconds = NOW) => checkSignature({ verify: rule, headers: given, body: text, secret, nowSeconds }).reason ?? 'ok';
  assert.equal(check(headers()), 'ok');
  assert.equal(check(headers(), body.replace('FRIEND-7K3Q', 'FRIEND-0000')), 'signature-mismatch');
  assert.equal(check(headers(NOW - 301)), 'outside-replay-window');
  assert.equal(check({ ...headers(), 'x-sign-in-signature': headers()['x-sign-in-signature'].toUpperCase() }), 'no-signature');
  assert.equal(check({ 'x-sign-in-signature': headers()['x-sign-in-signature'] }), 'missing-signed-part');
  const shape = { place: { value: 'person' }, change: { path: 'change', map: {}, otherwise: 'added' }, key: 'user_id', at: 'made_at', at_unit: 'iso' };
  const { changes } = changesOf({ shape, where: 'site-sign-ins', body });
  assert.deepEqual(changes.map(one => one.detail), [{ where: 'site-sign-ins', place: 'person', change: 'added', at: '2026-11-25T21:00:00.000Z', key: 'u-41', before: null, after: body }]);
});
