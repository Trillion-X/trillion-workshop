// tools/use-trillion-from-a-shell/test/trillion-timeout.test.mjs
//
// `trillion --timeout SECONDS` sets how long one call may wait. The wait is a whole number from 1 up to the engine's call
// deadline in trillion.json (call_timeout_seconds), which is also the wait when no --timeout is given: a larger value is
// refused, never raised. A door that never answers is given up on after the chosen wait, and the message says that wait.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import settings from '../do-work/trillion.json' with { type: 'json' };
import { main, stateOf, trillionClient, TrillionError } from '../do-work/trillion.mjs';

const KEY = `nm_${'ab'.repeat(16)}`;
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };
const home = () => mkdtempSync(join(tmpdir(), 'trillion-timeout-'));

/** A door that never answers: each call waits until its signal ends it, and the waits are kept in `waits`. */
const silentDoor = () => {
  const waits = [];
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    waits.push(init.signal);
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  return { waits, fetchImpl };
};

const run = (argv, door) => main([...argv, '--origin', 'http://127.0.0.1:8788'], {
  env: { TRILLION_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: home() }),
  fetchImpl: door.fetchImpl, wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
});

test('--timeout 1 gives up on a silent door after one second and says that wait', async () => {
  const door = silentDoor();
  const began = Date.now();
  await assert.rejects(run(['op', '@own-records', 'records:read', '{"id":"x"}', '--timeout', '1'], door), error => {
    assert.ok(error instanceof TrillionError);
    assert.match(error.message, /did not answer within 1 seconds/);
    return true;
  });
  assert.ok(Date.now() - began < 5000, 'the wait is the chosen second, not the engine deadline');
});

test('the wait is never more than the engine call deadline in DATA: a larger --timeout is refused, the default is the deadline', async () => {
  const max = settings.call_timeout_seconds;
  for (const value of [`${max + 1}`, '0', '-3', '1.5', 'soon']) {
    await assert.rejects(run(['call', 'tool:any', '{}', '--timeout', value], silentDoor()), error => {
      assert.equal(error.status, 2);
      assert.match(error.message, new RegExp(`from 1 to ${max}, the engine's call deadline`));
      return true;
    }, `--timeout ${value}`);
  }
});

test('the default wait and the bound both come from the deadline in DATA, whatever number the caller asks for', async () => {
  const rules = { ...settings, call_timeout_seconds: 1, retry_seconds: [] };
  const credential = { kind: 'key', bearer: KEY, where: 'test' };
  const door = { name: 'test door', mcp: 'http://127.0.0.1:8788/mcp', local: false };
  const cases = [[undefined, 1], [5, 1]];
  for (const [timeoutSeconds, expected] of cases) {
    const silent = silentDoor();
    const client = trillionClient({ door, credential, rules, fetchImpl: silent.fetchImpl, wait: async () => {}, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) });
    const began = Date.now();
    await assert.rejects(client.op('@own-records', 'records:read', { id: 'x' }), error => {
      assert.match(error.message, new RegExp(`did not answer within ${expected} seconds`));
      return true;
    });
    assert.ok(Date.now() - began < 5000, `${timeoutSeconds ?? 'default'} waited for ${expected} second`);
  }
});
