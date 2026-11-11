// tools/sign-a-mac-app-update/test/sign-a-mac-app-update.test.mjs
//
// A synthetic Ed25519 key stands in for the vault's held key, on a synthetic account. A stub door signs with that key the way
// the engine's held-values:sign does, and answers the signature in hex. Proved here: the signature verifies over the payload,
// the one call carries this run's capability and the fixed key name and operation, and a refused input never reaches the door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { KEY_NAME, OPERATION, SignError, signRecordText } from '../do-work/sign-a-mac-app-update.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const door = { url: 'https://door.test/mcp', resource: 'resource:synthetic-account', capability: 'capability-synthetic-run-7' };

/** A stub door that signs the requested payload with the synthetic key, as the vault would, and records each call. */
function stubDoor(calls, { answer } = {}) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (answer) return answer;
    const args = calls.at(-1).body.params.arguments;
    const signature = sign(null, Buffer.from(args.input.payload, 'utf8'), privateKey).toString('hex');
    const result = { structuredContent: { signature } };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('the signature verifies over the payload and is base64 for the record', async () => {
  const calls = [];
  const payload = 'trillion-mac-update-v1\n202611112042\n202611112042\nhttps://app.gettrillion.ai/download/Trillion-202611112042.dmg\nabc';
  const answer = await signRecordText({ payload, door, fetchImpl: stubDoor(calls) });
  assert.equal(answer.name, KEY_NAME);
  const signature = Buffer.from(answer.signature_base64, 'base64');
  assert.equal(signature.length, 64);
  assert.ok(verify(null, Buffer.from(payload, 'utf8'), publicKey, signature), 'the signature verifies with the public half');
});

test('the one call carries this run capability and the fixed key name and operation', async () => {
  const calls = [];
  await signRecordText({ payload: 'lines', door, fetchImpl: stubDoor(calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, door.url);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${door.capability}`);
  const call = calls[0].body.params.arguments;
  assert.equal(call.address, '@held-values');
  assert.equal(call.method, OPERATION);
  assert.equal(call.input.name, KEY_NAME);
  assert.match(call.request_key, /^sign:/);
});

test('an empty payload and one over 64 KiB are refused before any call', async () => {
  const calls = [];
  await assert.rejects(signRecordText({ payload: '', door, fetchImpl: stubDoor(calls) }), SignError);
  await assert.rejects(signRecordText({ payload: 'x'.repeat(64 * 1024 + 1), door, fetchImpl: stubDoor(calls) }), SignError);
  assert.equal(calls.length, 0, 'nothing reaches the door');
});

test('a refused run says so without echoing the capability', async () => {
  const unauthorized = async () => new Response('denied', { status: 401 });
  await assert.rejects(signRecordText({ payload: 'lines', door, fetchImpl: unauthorized }), error => {
    assert.ok(error instanceof SignError);
    assert.equal(error.status, 4);
    assert.ok(!error.message.includes(door.capability), 'the capability is never in an error');
    return true;
  });
});

test('an answer without a 128-digit hex signature is refused', async () => {
  const bad = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { signature: 'nope' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(signRecordText({ payload: 'lines', door, fetchImpl: bad }), SignError);
});
