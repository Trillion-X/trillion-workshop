// test/reconcile-fields.test.mjs
// This Mac sends the account only what it does not already hold (F-0242).
import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcile } from '../reconcile-fields.mjs';
import { makeCarrier } from '../carry-connections.mjs';
import settings from '../carry-connections.json' with { type: 'json' };

test('only differing fields are in the patch; key order and identity do not matter', () => {
  const held = { name: 'A', skills: [{ id: 'x', name: 'X' }], capacity: { n: 1 } };
  assert.equal(reconcile({ capacity: { n: 1 }, skills: [{ name: 'X', id: 'x' }], name: 'A' }, held).holds, true);
  const r = reconcile({ name: 'B', skills: [{ id: 'x', name: 'X' }], where: 'mac' }, held);
  assert.deepEqual(r.patch, { name: 'B', where: 'mac' });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(reconcile({ name: 'A' }, held, { exact: true }).removed, ['skills', 'capacity']);
  assert.deepEqual(reconcile({ a: 1 }, null).changed, ['a']);
});

test('the carrier republishes its card only when the account does not already hold it', async () => {
  const calls = [];
  const connections = new Map([['imessage', { row: { label: 'iMessage' }, module: { start: async () => ({ carried: true, account: 'me' }), carried: () => true } }]]);
  const carrier = makeCarrier({ settings, connections, call: async (path, body) => { calls.push(path); return {}; }, computer: 'My Mac', kept: { get: () => null, put() {} } });
  await carrier.publish(); await carrier.publish();
  assert.deepEqual(calls, ['/agents/publish', '/agents/presence', '/agents/presence']);
  connections.get('imessage').module.carried = () => false;
  await carrier.publish();
  assert.deepEqual(calls.slice(3), ['/agents/publish', '/agents/presence']);
  console.log('readback calls:', calls.join(' '));
});
