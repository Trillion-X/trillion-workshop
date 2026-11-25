// tools/use-your-tools-from-a-shell/test/command-asks-again-follows-the-run.test.mjs
//
// A call asked again under its request key follows the run that key already names: a try with no answer, or one the engine
// answers as still going (tools_run_in_progress), is asked again with the same key, and the person is told the run may still
// be going and is followed, not started again. A call the engine answers with an unknown outcome names its key and the exact
// flag to ask again with it. Nov 25 2026: a resync the gateway cut at 120 s was asked again under its key; the answer said
// "Ask again with the same request key" and named no key.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import settings from '../do-work/command.json' with { type: 'json' };
import { main, stateOf, engineClient, CommandError, speakFor } from '../do-work/command.mjs';

speakFor({ cli: 'example', site_name: 'Example' });

const KEY = `nm_${'ab'.repeat(16)}`;
const credential = { kind: 'key', bearer: KEY, where: 'test' };
const door = { name: 'test door', mcp: 'http://127.0.0.1:8788/mcp', local: false };
const reply = (id, result) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }) });
const refusal = structuredContent => ({ isError: true, structuredContent });

test('a run with no answer and then still going is followed under its one key to its end, and the person is told so', async () => {
  const rules = { ...settings, retry: { ...settings.retry, count: 4, first_seconds: 0, most_seconds: 0, attempt_seconds: 0.02 } };
  const keys = [], said = [];
  const fetchImpl = (_url, init) => new Promise((resolve, reject) => {
    const body = JSON.parse(init.body);
    keys.push(body.params.arguments.request_key);
    // The first try is not answered in time (the run is going on the computer); the second finds it still going; the third
    // is answered from the run that key names.
    if (keys.length === 1) init.signal.addEventListener('abort', () => reject(init.signal.reason));
    else if (keys.length === 2) resolve(reply(body.id, refusal({ code: 'tools_run_in_progress', outcome: 'unknown' })));
    else resolve(reply(body.id, { structuredContent: { result: { deployed: 1 }, replayed: true } }));
  });
  const client = engineClient({ door, credential, rules, fetchImpl, wait: async () => {}, say: text => said.push(text) });
  const answer = await client.op(null, 'tools:run', { tool: 'tool:resync', input: {} }, { requestKey: 'resync-key' });
  assert.deepEqual(answer, { result: { deployed: 1 }, replayed: true });
  assert.deepEqual(keys, ['resync-key', 'resync-key', 'resync-key'], 'every try carries the one key: no new run is asked for');
  assert.equal(said.length, 2, said.join('\n'));
  assert.match(said[0], /may still be going/);
  assert.match(said[0], /same request key/);
  assert.match(said[0], /does not start it again/);
  assert.match(said[1], /still going/);
  assert.match(said[1], /follow it to its end/);
});

test('an unknown outcome names the request key and the exact flag to ask again with it', async () => {
  const sent = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.params.arguments.request_key);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: refusal({ code: 'tools_run_outcome_unknown', outcome: 'unknown',
      detail: 'The computer did not answer within 120 s, so the run may still be going there. Ask again with the same request key to read how it ended.' }) });
  };
  const run = argv => main([...argv, '--origin', 'http://127.0.0.1:8788'], {
    env: { EXAMPLE_KEY: KEY }, store: { read: () => KEY, where: 'test key' },
    grants: { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} },
    state: stateOf({ home: tempFolder(join(tmpdir(), 'example-follow-')) }),
    fetchImpl, wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
  });
  await assert.rejects(run(['op', 'tools:run', '{"tool":"tool:resync","input":{}}', '--request-key', 'cut-key-1']), error => {
    assert.ok(error instanceof CommandError, String(error));
    assert.match(error.message, /Ask again with the same request key/);
    assert.match(error.message, /Reference: cut-key-1\./, 'the answer names the key');
    assert.match(error.message, /--request-key cut-key-1/, 'and the exact flag to ask again with it');
    return true;
  });
  await assert.rejects(run(['op', 'tools:run', '{"tool":"tool:resync","input":{}}']), error => {
    const named = error.message.match(/--request-key ([^\s]+) to the command/)?.[1];
    assert.equal(named, sent.at(-1), 'a key the command made is named too: the one it sent');
    return true;
  });
});
