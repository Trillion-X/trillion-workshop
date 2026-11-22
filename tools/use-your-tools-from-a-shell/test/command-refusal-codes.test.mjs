// A refusal code with words in command.json says them; one without words says its code, never the bare sentence.
import assert from 'node:assert/strict';
import test from 'node:test';
import settings from '../do-work/command.json' with { type: 'json' };
import { engineClient, speakFor, siteOf } from '../do-work/command.mjs';

speakFor(siteOf({ invoked: 'example-cli', home: '/nonexistent' }));

const refusedWith = async code => {
  const fetchImpl = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, structuredContent: { code } } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  const client = engineClient({ door: { name: 'Example', mcp: 'https://example.com/mcp' }, credential: { kind: 'key', bearer: 'synthetic' }, fetchImpl, wait: async () => {} });
  return client.op('@tools', 'tools:run', {}).then(() => null, error => error);
};

test('door_full is said in plain words that tell the person to try again', async () => {
  const error = await refusedWith('door_full');
  assert.equal(error.code, 'door_full');
  assert.equal(error.message, settings.words.codes.door_full);
  assert.match(error.message, /try again in a moment/);
});

test('a code with no words prints its code, never the bare sentence', async () => {
  const error = await refusedWith('some_new_refusal');
  assert.equal(error.code, 'some_new_refusal');
  assert.match(error.message, /some_new_refusal/);
  assert.notEqual(error.message, 'Example did not do that.');
});
