// A send from the browser is kept on the device when the account cannot be reached, and sent again with the same
// request_key (extension/src/outbox.mjs); a send the account kept at its edge ({ queued: true }) is a success.
import test from 'node:test';
import assert from 'node:assert/strict';
import { drainOutbox, keepSend, sendOrKeep, Unreachable, waiting } from '../src/outbox.mjs';
import { writeArguments } from '../src/share-record.mjs';

const memory = () => {
  const data = {};
  return { get: async key => ({ [key]: data[key] }), set: async rows => { Object.assign(data, rows); } };
};
const signedIn = id => async () => id;
const args = (over = {}) => writeArguments({ requestKey: 'key-1', items: [{ kind: 'page', url: 'https://a.example/' }], from: 'Chrome', at: '2026-10-30T19:00:00.000Z', ...over });

test('an unreachable account keeps the send, and each retry uses the same request_key until it is answered', async () => {
  const area = memory();
  const keys = [];
  let up = false;
  const tool = async (name, given) => {
    assert.equal(name, 'run_resource_operation');
    keys.push(given.request_key);
    if (!up) throw new Unreachable();
    return { changed: 1 };
  };
  const first = await sendOrKeep({ tool, args: args(), area, account: 'account-a' });
  assert.deepEqual([first.state, first.where], ['kept', 'device']);
  assert.equal((await waiting(area)).length, 1);
  assert.equal(await drainOutbox({ tool, area, account: signedIn('account-a') }), 0);
  assert.equal((await waiting(area)).length, 1);
  up = true;
  assert.equal(await drainOutbox({ tool, area, account: signedIn('account-a') }), 1);
  assert.deepEqual(await waiting(area), []);
  assert.deepEqual(keys, ['key-1', 'key-1', 'key-1']);
});

test('a network error (a failed fetch) is kept too; a refusal in words is said, not kept', async () => {
  const area = memory();
  const offline = await sendOrKeep({ tool: async () => { throw new TypeError('Failed to fetch'); }, args: args(), area });
  assert.equal(offline.state, 'kept');
  await assert.rejects(sendOrKeep({ tool: async () => { throw new Error('Not on your plan'); }, args: args({ requestKey: 'key-2' }), area }), /plan/);
  assert.deepEqual((await waiting(area)).map(row => row.request_key), ['key-1']);
});

test('queued:true is kept at the account\'s edge: a success that is not put in the outbox', async () => {
  const area = memory();
  const done = await sendOrKeep({ tool: async () => ({ queued: true, request_key: 'key-1', words: 'Kept.' }), args: args(), area });
  assert.deepEqual([done.state, done.where], ['kept', 'account']);
  assert.deepEqual(await waiting(area), []);
});

test('a kept send the account later refuses is marked refused and not tried again; the rest still go', async () => {
  const area = memory();
  await keepSend({ args: args({ requestKey: 'bad' }), area, account: 'account-a' });
  await keepSend({ args: args({ requestKey: 'good' }), area, account: 'account-a' });
  const asked = [];
  const tool = async (_name, given) => { asked.push(given.request_key); if (given.request_key === 'bad') throw new Error('Nothing is set for your AI to do.'); return {}; };
  assert.equal(await drainOutbox({ tool, area, account: signedIn('account-a') }), 1);
  assert.equal(await drainOutbox({ tool, area, account: signedIn('account-a') }), 0);
  assert.deepEqual(asked, ['bad', 'good']);
  const left = await waiting(area);
  assert.deepEqual(left.map(row => row.request_key), ['bad']);
  assert.match(left[0].refused, /Nothing is set/);
});

test('a kept send goes only while its own account is signed in; another account never sends it, and it waits for its owner', async () => {
  const area = memory();
  await keepSend({ args: args({ requestKey: 'from-a' }), area, account: 'account-a' });
  const asked = [];
  const tool = async (_name, given) => { asked.push(given.request_key); return { changed: 1 }; };
  assert.equal(await drainOutbox({ tool, area, account: signedIn('account-b') }), 0);
  assert.equal(await drainOutbox({ tool, area, account: signedIn(null) }), 0);
  assert.deepEqual(asked, []);
  assert.equal((await waiting(area)).length, 1);
  assert.equal(await drainOutbox({ tool, area, account: signedIn('account-a') }), 1);
  assert.deepEqual(asked, ['from-a']);
});

test('a kept send that names no account is never sent as whoever is signed in', async () => {
  const area = memory();
  await area.set({ outbox: [{ request_key: 'older', args: args({ requestKey: 'older' }), kept_at: 1 }] });
  const asked = [];
  assert.equal(await drainOutbox({ tool: async (_name, given) => { asked.push(given.request_key); return {}; }, area, account: signedIn('account-b') }), 0);
  assert.deepEqual(asked, []);
  assert.equal((await waiting(area)).length, 1);
});

test('a pre-migration destination share stays intact until its chosen destination and action can be preserved', async () => {
  const area = memory();
  const legacy = {
    request_key: 'legacy-share', account: 'account-a', kept_at: 10,
    args: { request_key: 'legacy-share', items: [{ kind: 'page', url: 'https://a.example/' }],
      to: ['pursuit:one'], action: 'tool:read-it', own_words: 'keep this context' },
  };
  await area.set({ outbox: [legacy] });
  const asked = [];
  assert.equal(await drainOutbox({ tool: async (...call) => { asked.push(call); return {}; }, area, account: signedIn('account-a') }), 0);
  assert.deepEqual(asked, [], 'legacy destination intent is never sent as an unrelated records:write');
  assert.deepEqual(await waiting(area), [{ ...legacy, migration_required: true }], 'the original retry key and selected action remain recoverable');
});

test('the account is asked again before each send, so a sign-out part way stops the rest', async () => {
  const area = memory();
  await keepSend({ args: args({ requestKey: 'one' }), area, account: 'account-a' });
  await keepSend({ args: args({ requestKey: 'two' }), area, account: 'account-a' });
  let current = 'account-a';
  const asked = [];
  const tool = async (_name, given) => { asked.push(given.request_key); current = 'account-b'; return {}; };
  assert.equal(await drainOutbox({ tool, area, account: async () => current }), 1);
  assert.deepEqual(asked, ['one']);
  assert.deepEqual((await waiting(area)).map(row => row.request_key), ['two']);
});
