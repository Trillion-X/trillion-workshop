// tools/use-trillion-from-a-shell/test/trillion-op-request-key.test.mjs
//
// A `trillion op` or `trillion call` that times out names the request key it sent, and `--request-key` sends that same key
// again: the engine answers the call it already has under that key, so a retry after a timeout is never a second run.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main, stateOf, TrillionError } from '../do-work/trillion.mjs';

const ORIGIN = 'http://127.0.0.1:8788';
const KEY = `nm_${'ab'.repeat(16)}`;
const home = () => mkdtempSync(join(tmpdir(), 'trillion-op-key-'));
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };
const WRITE = ['op', '@own-records', 'records:write', '{"records":[{"id":"note:one","type":"note","value":{"words":"kept"}}]}'];
const committed = { structuredContent: { committed: true, write_count: 1 }, content: [] };

/** A fake door whose first `timeouts` asks fail as a timed-out request; every ask is kept with its request key. */
function fakeDoor(timeouts) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.params.arguments.request_key);
    if (seen.length <= timeouts) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: committed });
  };
  return { seen, fetchImpl };
}

const run = (argv, door) => main([...argv, '--origin', ORIGIN], {
  env: { TRILLION_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: home() }),
  fetchImpl: door.fetchImpl, wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
});

test('a timed-out op names the request key it sent, and --request-key sends that same key again', async () => {
  const first = fakeDoor(1);
  await assert.rejects(run([...WRITE, '--request-key', 'retry-key-1'], first), error => {
    assert.ok(error instanceof TrillionError, String(error));
    assert.match(error.message, /retry-key-1/, 'the timeout names the key');
    assert.match(error.message, /--request-key retry-key-1/, 'the timeout says how to ask again');
    return true;
  });
  const retry = fakeDoor(0);
  const output = await run([...WRITE, '--request-key', 'retry-key-1'], retry);
  assert.match(output, /"committed": true/);
  assert.deepEqual([...new Set([...first.seen, ...retry.seen])], ['retry-key-1'], 'the first ask and the retry carry one key');
});

test('a timed-out op with no --request-key still names the key it generated, and a short key is sent unchanged', async () => {
  const door = fakeDoor(1);
  await assert.rejects(run(WRITE, door), error => {
    const named = error.message.match(/--request-key ([^\s:]+)/)?.[1];
    assert.ok(named, error.message);
    assert.equal(named, door.seen[0], 'the key named is the key that was sent');
    return true;
  });
});
