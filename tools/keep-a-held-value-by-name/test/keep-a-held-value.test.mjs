// tools/keep-a-held-value-by-name/test/keep-a-held-value.test.mjs
//
// Made-up door answers only. The stub door records each request body, so the test can show that the value travels in the
// body and never in an argument, a log line or the answer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { keepHeldValue, readStdin, removeHeldValue, valueOf } from '../do-work/keep-a-held-value.mjs';
import { trillionClient } from '../../use-trillion-from-a-shell/do-work/trillion.mjs';

// A door that answers each JSON-RPC call with the structured content it is given, and keeps every request body it was sent.
function stubDoor(answer) {
  const bodies = [];
  const fetchImpl = async (url, { body }) => {
    bodies.push(JSON.parse(body));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: answer, isError: false } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = trillionClient({ door: { name: 'test door', mcp: 'https://door.test/mcp' }, credential: { kind: 'key', bearer: 'nm_synthetic' }, fetchImpl });
  return { client, bodies };
}

test('a held value goes to held-values:put in the request body, under its name, and the answer carries neither the value nor a copy of it', async () => {
  const { client, bodies } = stubDoor({ accepted: true });
  const answer = await keepHeldValue({ name: 'engine-release-push', value: 'synthetic-value-7f3a', client });
  assert.deepEqual(answer, { name: 'engine-release-push', accepted: true });
  const [sent] = bodies;
  const call = sent.params.arguments;
  assert.equal(sent.params.name, 'run_resource_operation');
  assert.equal(call.address, '@held-values');
  assert.equal(call.method, 'held-values:put');
  assert.deepEqual(call.input, { name: 'engine-release-push', value: 'synthetic-value-7f3a' });
  assert.ok(!JSON.stringify(answer).includes('synthetic-value-7f3a'));
});

test('a door that does not accept the value is an error, never a silent success', async () => {
  const { client } = stubDoor({ accepted: false });
  await assert.rejects(keepHeldValue({ name: 'engine-release-push', value: 'x', client }), /did not accept/);
});

test('an empty value and a missing name are refused before any call is sent', async () => {
  const { client, bodies } = stubDoor({ accepted: true });
  await assert.rejects(keepHeldValue({ name: 'engine-release-push', value: '', client }), /empty/);
  await assert.rejects(keepHeldValue({ name: '', value: 'x', client }), /Name the held value/);
  assert.equal(bodies.length, 0);
});

test('stdin keeps every byte of the value except one trailing newline', async () => {
  assert.equal(valueOf('abc\n'), 'abc');
  assert.equal(valueOf('abc\r\n'), 'abc');
  assert.equal(valueOf('ab\nc'), 'ab\nc');
  const stream = (await import('node:stream')).Readable.from([Buffer.from('se'), Buffer.from('cret\n')]);
  assert.equal(valueOf(await readStdin(stream)), 'secret');
});

test('a removal goes to held-values:remove with the name alone, and the answer says whether a value was held and what is known at the issuer', async () => {
  const held = stubDoor({ name: 'synthetic-old-key', removed: true });
  assert.deepEqual(await removeHeldValue({ name: 'synthetic-old-key', issuerStatus: 'revoked', client: held.client }),
    { name: 'synthetic-old-key', removed: true, issuer_status: 'revoked' });
  const call = held.bodies[0].params.arguments;
  assert.equal(call.address, '@held-values');
  assert.equal(call.method, 'held-values:remove');
  assert.deepEqual(call.input, { name: 'synthetic-old-key' });
  const absent = stubDoor({ name: 'synthetic-old-key', removed: false });
  assert.deepEqual(await removeHeldValue({ name: 'synthetic-old-key', issuerStatus: 'unknown', client: absent.client }),
    { name: 'synthetic-old-key', removed: false, issuer_status: 'unknown' });
});

test('a removal away from the writer says it was queued, and an answer that says neither is an error', async () => {
  const queued = stubDoor({ name: 'synthetic-old-key', queued: true });
  assert.deepEqual(await removeHeldValue({ name: 'synthetic-old-key', issuerStatus: 'unknown', client: queued.client }),
    { name: 'synthetic-old-key', queued: true, issuer_status: 'unknown' });
  const unclear = stubDoor({});
  await assert.rejects(removeHeldValue({ name: 'synthetic-old-key', issuerStatus: 'unknown', client: unclear.client }), /did not answer the removal/);
});

test('a removal is refused before any call is sent when it has no name or says nothing about the issuer', async () => {
  const { client, bodies } = stubDoor({ removed: true });
  await assert.rejects(removeHeldValue({ name: '', issuerStatus: 'revoked', client }), /Name the held value/);
  await assert.rejects(removeHeldValue({ name: 'synthetic-old-key', client }), /--issuer-status revoked or unknown/);
  await assert.rejects(removeHeldValue({ name: 'synthetic-old-key', issuerStatus: 'maybe', client }), /--issuer-status revoked or unknown/);
  assert.equal(bodies.length, 0);
});

test('a removal sends the same request key each time it is made, so a retry after a timeout is the same call', async () => {
  const first = stubDoor({ name: 'synthetic-old-key', removed: true });
  const second = stubDoor({ name: 'synthetic-old-key', removed: true });
  await removeHeldValue({ name: 'synthetic-old-key', issuerStatus: 'revoked', client: first.client });
  await removeHeldValue({ name: 'synthetic-old-key', issuerStatus: 'revoked', client: second.client });
  assert.equal(first.bodies[0].params.arguments.request_key, second.bodies[0].params.arguments.request_key);
});
