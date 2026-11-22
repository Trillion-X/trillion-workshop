// A waiter pass never waits on a service without a bound: a list request that never answers is given up after the row's
// request_timeout_seconds and the pass ends with its reason; a request that answers in time is read as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readList, readSettings } from '../do-work/mechanisms/service-lists.mjs';

const hangingFetch = (url, { signal }) => new Promise((resolve, reject) => {
  signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: signal.reason?.name ?? 'AbortError' })));
});
const ownFor = (settings) => ({ ...readSettings({ request: { url: 'https://service.invalid/list' }, shape: { items: 'data', key: 'id', place: { value: 'x' } }, ...settings }) });

test('a list request that never answers ends the pass with its reason, after the row\'s timeout', async () => {
  const own = ownFor({ request_timeout_seconds: 1 });
  const started = Date.now();
  await assert.rejects(() => readList(own, 'made-up-credential', hangingFetch), /did not answer within 1 seconds, so this pass ends/);
  assert.ok(Date.now() - started < 5000);
});

test('the default bound is 30 seconds when the row names none', () => {
  assert.equal(ownFor({}).request_timeout_ms, 30000);
});

test('a list that answers in time is read as before', async () => {
  const own = ownFor({ request_timeout_seconds: 5 });
  const answering = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 1 }, { id: 2 }] }) });
  const { items, whole } = await readList(own, 'made-up-credential', answering);
  assert.deepEqual(items.map((item) => item.id), [1, 2]);
  assert.equal(whole, false);
});
