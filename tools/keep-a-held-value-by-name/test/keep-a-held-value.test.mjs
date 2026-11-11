// tools/keep-a-held-value-by-name/test/keep-a-held-value.test.mjs
//
// Made-up door answers only. The stub door records each request body, so the test can show that the value travels in the
// body and never in an argument, a log line or the answer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { keepHeldValue, readStdin, valueOf } from '../do-work/keep-a-held-value.mjs';
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
