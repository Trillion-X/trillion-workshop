// test/record-requests.test.mjs
// A client write sent again inside the window is answered from the first and writes nothing; one sent before the
// window is refused; a restarted store still knows the keys it took; the window is bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { requestWindow, StaleRequest } from '../../record-log/do-work/record-requests.mjs';

const opened = () => { const host = sqliteHost(':memory:'); return { host, store: recordLogStore(host.sql, { transaction: host.transaction }) }; };
const rows = store => store.logAfter(null, { limit: 10000 }).rows.length;

test('the same request key twice writes once and answers the first', () => {
  const { store } = opened();
  const requests = requestWindow(store);
  const first = requests.write([{ id: 'note:a', type: 'note', value: { text: 'one' } }], { request_key: 'k1', sent_at: new Date().toISOString() });
  assert.equal(first.transaction_id, 'k1');
  const again = requests.write([{ id: 'note:a', type: 'note', value: { text: 'two' } }], { request_key: 'k1', sent_at: new Date().toISOString() });
  assert.deepEqual(again, { transaction_id: 'k1', duplicate: true });
  assert.equal(store.read('note:a').text, 'one');
  assert.equal(rows(store), 1);
});

test('a write without a request key is an ordinary write', () => {
  const { store } = opened();
  const requests = requestWindow(store);
  requests.write([{ id: 'note:a', type: 'note', value: { text: 'one' } }]);
  requests.write([{ id: 'note:a', type: 'note', value: { text: 'two' } }]);
  assert.equal(store.read('note:a').text, 'two');
});

test('a request sent before the window is refused, not guessed at', () => {
  const { store } = opened();
  let now = Date.now();
  const requests = requestWindow(store, { window_ms: 1000, now: () => now });
  assert.throws(() => requests.write([{ id: 'note:a', type: 'note', value: { text: 'old' } }], { request_key: 'k-old', sent_at: new Date(now - 5000).toISOString() }), StaleRequest);
  assert.equal(store.read('note:a'), null);
  requests.write([{ id: 'note:a', type: 'note', value: { text: 'one' } }], { request_key: 'k1', sent_at: new Date(now).toISOString() });
  now += 2000;
  assert.throws(() => requests.write([{ id: 'note:a', type: 'note', value: { text: 'again' } }], { request_key: 'k1', sent_at: new Date(now - 2000).toISOString() }), error => error.code === 'stale_request');
  assert.equal(store.read('note:a').text, 'one');
});

test('a restarted store still knows the requests it took inside the window', () => {
  const { host, store } = opened();
  requestWindow(store).write([{ id: 'note:a', type: 'note', value: { text: 'one' } }], { request_key: 'k1' });
  const reopened = recordLogStore(host.sql, { transaction: host.transaction });
  const requests = requestWindow(reopened);
  assert.equal(requests.seen('k1'), true);
  assert.deepEqual(requests.write([{ id: 'note:a', type: 'note', value: { text: 'two' } }], { request_key: 'k1' }), { transaction_id: 'k1', duplicate: true });
  assert.equal(reopened.read('note:a').text, 'one');
});

test('the window holds at most most_keys keys and refuses what it let go', () => {
  const { store } = opened();
  let now = Date.now();
  const requests = requestWindow(store, { most_keys: 3, now: () => now });
  for (let k = 0; k < 5; k += 1) { now += 10; requests.write([{ id: `note:${k}`, type: 'note', value: { k } }], { request_key: `k${k}`, sent_at: new Date(now).toISOString() }); }
  assert.equal(requests.seen('k4'), true);
  assert.equal(requests.seen('k0'), false);
  assert.throws(() => requests.write([{ id: 'note:0', type: 'note', value: { k: 'again' } }], { request_key: 'k0', sent_at: new Date(now - 40).toISOString() }), StaleRequest);
  assert.equal(store.read('note:0').k, 0);
});
