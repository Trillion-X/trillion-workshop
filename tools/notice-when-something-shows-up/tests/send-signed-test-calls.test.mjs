// tool:send-signed-test-calls against the real signed webhook receiver on loopback, with a made-up secret: a good call
// told, a bad, a missing and an old signature refused, a call over the cap refused before it is read, and the very same
// signed call sent again kept once. The answer carries statuses and replies only: never the secret or a signature.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReceiver, receiverConfigOf } from '../do-work/signed-webhook-receiver.mjs';
import { requestOf, sendCalls } from '../do-work/send-signed-test-calls.mjs';

const SECRET = `whsec_${Buffer.from('made-up-test-calls-key').toString('base64')}`;
const SVIX = { parts: { id: { header: 'svix-id' }, ts: { header: 'svix-timestamp' }, sig: { header: 'svix-signature', match: '(?:^| )v1,([A-Za-z0-9+/=]+)' } },
  signed: '{id}.{ts}.{body}', signature: 'sig', hash: 'sha256', encoding: 'base64', secret_prefix: 'whsec_', secret_encoding: 'base64', timestamp: 'ts', tolerance_seconds: 300 };
const CONFIG = receiverConfigOf({ listen_host: '127.0.0.1', listen_port: 0, path: '/webhooks/sample', secret_credential: 'sample-signing-secret', verify: SVIX,
  shape: { place: { path: 'type' }, change: { path: 'type', map: { 'email.delivered': 'changed' } }, key: ['data.email_id'], at: ['created_at'], at_unit: 'iso' },
  where: 'sample-service', kind: 'sample-event', body_byte_ceiling: 4096, door: 'http://127.0.0.1:7190' });
const INPUT = {
  url: 'https://receiver.example.test/webhooks/sample',
  sign: { signed: '{id}.{ts}.{body}', hash: 'sha256', encoding: 'base64', secret_prefix: 'whsec_', secret_encoding: 'base64' },
  headers: { 'svix-id': '{id}', 'svix-timestamp': '{ts}', 'svix-signature': 'v1,{sig}' },
  calls: [
    { label: 'signed', body: { type: 'email.delivered', created_at: '2026-11-25T12:00:00.000Z', data: { email_id: 'em_test_1' } } },
    { label: 'signed-again', same_as: 'signed' },
    { label: 'bad-signature', body: { type: 'email.delivered', created_at: '2026-11-25T12:00:00.000Z', data: { email_id: 'em_test_2' } }, signature: 'bad' },
    { label: 'unsigned', body: { type: 'email.delivered', created_at: '2026-11-25T12:00:00.000Z', data: { email_id: 'em_test_3' } }, signature: 'none' },
    { label: 'too-old', body: { type: 'email.delivered', created_at: '2026-11-25T12:00:00.000Z', data: { email_id: 'em_test_4' } }, age_seconds: 600 },
    { label: 'too-large', body: { type: 'email.delivered', created_at: '2026-11-25T12:00:00.000Z', data: { email_id: 'em_test_5' } }, pad_bytes: 8000 },
  ],
};

test('each call is answered by the receiver as the service would be: told once, refused for each wrong signature, age and size', async () => {
  const facts = [];
  const server = createReceiver({ config: CONFIG, secret: SECRET, arrive: async (fact) => { facts.push(fact); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}/webhooks/sample`;
  const sentHeaders = [];
  const fetchImpl = (url, request) => { assert.equal(url, INPUT.url); sentHeaders.push(request.headers); return fetch(local, request); };
  try {
    const answer = await sendCalls({ secret: `${SECRET}\n`, input: INPUT, fetchImpl });
    assert.deepEqual(answer.calls.map(({ label, status }) => [label, status]), [
      ['signed', 200], ['signed-again', 200], ['bad-signature', 401], ['unsigned', 401], ['too-old', 401], ['too-large', 413],
    ]);
    const byLabel = Object.fromEntries(answer.calls.map((call) => [call.label, JSON.parse(call.reply)]));
    assert.deepEqual(byLabel['signed'], { recorded: true, changes: 1, duplicates: 0 });
    assert.deepEqual(byLabel['signed-again'], { recorded: true, changes: 1, duplicates: 1 });
    assert.equal(byLabel['bad-signature'].reason, 'signature-mismatch');
    assert.equal(byLabel['unsigned'].reason, 'no-signature');
    assert.equal(byLabel['too-old'].reason, 'outside-replay-window');
    assert.equal(byLabel['too-large'].reason, 'body-over-ceiling');
    assert.equal(facts.length, 1, 'only the good call reaches the engine, once');
    // The repeat is the very same call: its id, timestamp and signature equal the first one's.
    assert.deepEqual(sentHeaders[1], sentHeaders[0]);
    assert.equal('svix-signature' in sentHeaders[3], false, 'an unsigned call carries no signature headers');
    const said = JSON.stringify(answer);
    const signatures = sentHeaders.map((headers) => headers['svix-signature']).filter(Boolean).map((value) => value.slice(3));
    assert.ok(!said.includes(SECRET) && !said.includes(SECRET.slice(6)), 'the answer carries no secret');
    assert.ok(signatures.every((signature) => !said.includes(signature)), 'the answer carries no signature');
    for (const call of answer.calls) assert.deepEqual(Object.keys(call).sort(), ['label', 'reply', 'sent_at', 'status']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a receiver that echoes the secret has it replaced in the answer', async () => {
  const echo = async () => ({ status: 500, text: async () => `oops ${SECRET} leaked` });
  const answer = await sendCalls({ secret: SECRET, input: { ...INPUT, calls: [INPUT.calls[0]] }, fetchImpl: echo });
  assert.equal(answer.calls[0].status, 500);
  assert.ok(!answer.calls[0].reply.includes(SECRET));
  assert.match(answer.calls[0].reply, /\[redacted\]/);
});

test('a request that cannot be sent is refused by what to fix, and no secret is a refusal', async () => {
  assert.throws(() => requestOf({ ...INPUT, url: 'http://receiver.example.test/x' }), /https address/);
  assert.throws(() => requestOf({ ...INPUT, headers: { 'svix-id': '{id}' } }), /\{sig\}/);
  assert.throws(() => requestOf({ ...INPUT, calls: [{ label: 'again', same_as: 'first' }] }), /not an earlier call/);
  assert.throws(() => requestOf({ ...INPUT, calls: [{ label: 'a', body: {} }, { label: 'a', body: {} }] }), /its own label/);
  assert.throws(() => requestOf({ ...INPUT, sign: { ...INPUT.sign, hash: 'md5' } }), /hash/);
  await assert.rejects(sendCalls({ secret: '', input: INPUT, fetchImpl: async () => { throw new Error('no call'); } }), /No signing secret/);
});

test('the row mounts the held secret on a private pipe, reaches the internet, and its sample signs a made-up call', () => {
  const row = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map((record) => record.payload)
    .find((payload) => payload.id === 'tool:send-signed-test-calls');
  assert.ok(row);
  assert.deepEqual(row.invoke.key, [{ secret_name_from_input: 'secret_name', fd: 3 }]);
  assert.ok(Array.isArray(row.invoke.may_reach));
  assert.ok(row.input_schema.required.includes('secret_name'));
  assert.equal(row.verify[0].kind, 'sample-run');
  assert.ok(row.verify[0].held, 'the sample names a made-up held secret');
});
