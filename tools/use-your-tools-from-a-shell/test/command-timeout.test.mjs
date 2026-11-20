// tools/use-your-tools-from-a-shell/test/command-timeout.test.mjs
//
// A call has no deadline of its own. `retry.count` in command.json (one number, DATA) is how many more tries follow the first;
// each try waits `retry.attempt_seconds` (`--timeout SECONDS` sets that wait for one command), then is asked again under the
// SAME request key, so the door answers it with the first run's recorded result. Gaps double up to `most_seconds` and are cut
// down by `jitter`. A door that never answers is given up on only after every try, and the message says how many.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import settings from '../do-work/command.json' with { type: 'json' };
import { main, retryGap, stateOf, engineClient, CommandError, speakFor } from '../do-work/command.mjs';

// These tests speak for one site, as an install from that site's site makes the command do.
speakFor({ cli: 'example', site_name: 'Example' });

const KEY = `nm_${'ab'.repeat(16)}`;
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };
const home = () => tempFolder(join(tmpdir(), 'example-timeout-'));
const credential = { kind: 'key', bearer: KEY, where: 'test' };
const door = { name: 'test door', mcp: 'http://127.0.0.1:8788/mcp', local: false };

/** A door that never answers: each try waits until its signal ends it; the request bodies are kept in `bodies`. */
const silentDoor = () => {
  const bodies = [];
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    bodies.push(init.body);
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  return { bodies, fetchImpl };
};
const answer = (id, structuredContent) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result: { structuredContent } }) });

test('the number of tries is one DATA number and each gap doubles up to a top, cut by jitter', () => {
  assert.equal(settings.retry.count, 10);
  const retry = { ...settings.retry, first_seconds: 1, most_seconds: 8, jitter: 0.5 };
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(attempt => retryGap(retry, attempt, null, () => 0)), [1, 2, 4, 8, 8, 8]);
  assert.equal(retryGap(retry, 2, null, () => 1), 2, 'the most jitter takes half of the gap');
  assert.equal(retryGap(retry, 0, 5, () => 0), 5, "the door's own retry_after_seconds replaces the doubled gap");
  assert.equal(retryGap(retry, 0, 500, () => 0), 8, 'and stays under the top');
});

test('a try that gets no answer is asked again with the same request key until the count is spent, then the message says how many', async () => {
  const rules = { ...settings, retry: { ...settings.retry, count: 3, first_seconds: 1, most_seconds: 4, jitter: 0, attempt_seconds: 0.02 } };
  const silent = silentDoor();
  const waits = [];
  const client = engineClient({ door, credential, rules, fetchImpl: silent.fetchImpl, wait: async ms => { waits.push(ms); }, random: () => 0 });
  await assert.rejects(client.op(null, 'tools:run', { tool: 'tool:x', input: {} }, { requestKey: 'one-key' }), error => {
    assert.ok(error instanceof CommandError);
    assert.match(error.message, /did not answer after 4 tries\..* It may have happened/);
    return true;
  });
  assert.equal(silent.bodies.length, 4);
  assert.equal(new Set(silent.bodies).size, 1, 'every try is the same request, key and body');
  assert.deepEqual(waits, [1000, 2000, 4000]);
});

test('a slow first try does not lose the call: the next try carries the same key and its answer is the call\'s', async () => {
  const rules = { ...settings, retry: { ...settings.retry, count: 2, attempt_seconds: 0.02 } };
  let tries = 0;
  const keys = [];
  const fetchImpl = (_url, init) => new Promise((resolve, reject) => {
    tries += 1;
    keys.push(JSON.parse(init.body).params.arguments.request_key);
    if (tries === 1) init.signal.addEventListener('abort', () => reject(init.signal.reason));
    else resolve(answer(JSON.parse(init.body).id, { written: 1 }));
  });
  const client = engineClient({ door, credential, rules, fetchImpl, wait: async () => {} });
  assert.deepEqual(await client.op(null, 'tools:run', { tool: 'tool:x', input: {} }, { requestKey: 'slow-key' }), { written: 1 });
  assert.deepEqual(keys, ['slow-key', 'slow-key']);
});

test('a run the engine says is still going is asked again under its key instead of being refused', async () => {
  const rules = { ...settings, retry: { ...settings.retry, count: 3, first_seconds: 0, most_seconds: 0 } };
  let tries = 0;
  const fetchImpl = async (_url, init) => {
    tries += 1;
    const { id } = JSON.parse(init.body);
    if (tries < 3) return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result: { isError: true, content: [], structuredContent: { code: 'tools_run_in_progress', outcome: 'not_started' } } }) };
    return answer(id, { result: { done: true } });
  };
  const client = engineClient({ door, credential, rules, fetchImpl, wait: async () => {} });
  assert.deepEqual(await client.op('@tools', 'tools:run', { tool: 'tool:x', input: {} }, { requestKey: 'run-key' }), { result: { done: true } });
  assert.equal(tries, 3);
  // A refusal that is final stays final: a key reused for another tool is never asked again.
  tries = 0;
  const reused = async (_url, init) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: { isError: true, content: [], structuredContent: { code: 'tools_run_key_reused', outcome: 'not_started' } } }) });
  let asked = 0;
  const counting = (...args) => { asked += 1; return reused(...args); };
  await assert.rejects(engineClient({ door, credential, rules, fetchImpl: counting, wait: async () => {} }).op('@tools', 'tools:run', { tool: 'tool:y', input: {} }, { requestKey: 'run-key' }));
  assert.equal(asked, 1);
});

test('--timeout SECONDS is how long one try waits: any whole number from 1, no upper bound', async () => {
  const run = (argv, fetchImpl) => main([...argv, '--origin', 'http://127.0.0.1:8788'], {
    env: { EXAMPLE_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: home() }),
    fetchImpl, wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
  });
  for (const value of ['0', '-3', '1.5', 'soon']) {
    await assert.rejects(run(['call', 'tool:any', '{}', '--timeout', value], silentDoor().fetchImpl), error => { assert.equal(error.status, 2); assert.match(error.message, /whole number of seconds, at least 1/); return true; }, `--timeout ${value}`);
  }
  const silent = silentDoor();
  await assert.rejects(run(['op', 'wake:list', '{}', '--timeout', '1'], silent.fetchImpl), /did not answer after 11 tries/);
  assert.equal(silent.bodies.length, settings.retry.count + 1);
});
