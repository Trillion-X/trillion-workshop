import assert from 'node:assert/strict';
import test from 'node:test';
import { postWithBusyRetry, retryAfterSeconds } from '../harness/retry-source-return-request.mjs';

test('source return request retries a 503 and keeps the same idempotent body', async () => {
  const calls = [];
  const waits = [];
  const send = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return calls.length === 1
      ? { ok: false, status: 503, headers: { get: () => '3' } }
      : { ok: true, json: async () => ({ event_id: 'ev_1' }) };
  };
  const body = { type: 'source.return.check', idempotency_key: 'source-return:h_a:msg_b' };
  const result = await postWithBusyRetry('https://example.test/mcp/api/agents/events', body,
    { key: 'test-key', send, wait: async seconds => waits.push(seconds), backoffSeconds: [1] });
  assert.deepEqual(result, { event_id: 'ev_1' });
  assert.deepEqual(calls, [body, body]);
  assert.deepEqual(waits, [3]);
});

test('source return request does not retry a permanent refusal', async () => {
  let calls = 0;
  const result = await postWithBusyRetry('https://example.test', {}, { key: 'test-key',
    send: async () => { calls += 1; return { ok: false, status: 403 }; },
    wait: async () => assert.fail('must not wait') });
  assert.equal(result, null);
  assert.equal(calls, 1);
});

test('source return request retries a network reset and parses Retry-After dates', async () => {
  let calls = 0;
  const result = await postWithBusyRetry('https://example.test', {}, { key: 'test-key',
    send: async () => { if (++calls === 1) throw new Error('reset'); return { ok: true, json: async () => ({ ok: true }) }; },
    wait: async seconds => assert.equal(seconds, 2), backoffSeconds: [2] });
  assert.deepEqual(result, { ok: true });
  assert.equal(retryAfterSeconds('Thu, 01 Jan 1970 00:00:10 GMT', 5000), 5);
});
