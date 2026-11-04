import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteMadeAccount } from '../test-helpers/passkey-account.mjs';

function fixture(replies) {
  const calls = [];
  const page = { isClosed: () => false, context: () => ({ request: {
    get: async () => ({ status: () => 200, json: async () => ({ user_id: 'proof' }) }),
    post: async (url, input) => {
    calls.push({ url, input });
    const reply = replies[calls.length - 1];
    assert.ok(reply, 'deletion stays bounded');
    return { status: () => reply.status, json: async () => reply.body };
  } } }) };
  return { page, calls };
}

test('recognized reset retries the same account route and requires explicit deletion confirmation', async () => {
  const { page, calls } = fixture([
    { status: 400, body: { error: 'Durable Object reset because its code was updated.' } },
    { status: 200, body: { said: 'Your account is deleted.' } },
  ]);
  const waits = [];
  assert.equal(await deleteMadeAccount({ page, origin: 'https://proof.example.test', userId: 'proof', wait: async ms => waits.push(ms) }), null);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(waits, [5000]);
});

test('budget and input refusals are not retried even when a reply mentions a reset', async () => {
  for (const body of [{ error: 'Reduce the request', code: 'resource-exhausted', retryable: false },
    { error: 'Durable Object reset', retryable: false }, { error: 'Invalid input' }]) {
    const { page, calls } = fixture([{ status: 400, body }]);
    const failure = await deleteMadeAccount({ page, origin: 'https://proof.example.test', userId: 'proof', wait: async () => assert.fail('refusal must not wait') });
    assert.match(failure, /not deleted/);
    assert.equal(calls.length, 1);
  }
});

test('a second transient failure stays a failure instead of inventing deletion', async () => {
  const busy = { status: 503, body: { code: 'service-busy', retryable: true, error: 'Busy' } };
  const { page, calls } = fixture([busy, busy]);
  assert.match(await deleteMadeAccount({ page, origin: 'https://proof.example.test', userId: 'proof', wait: async () => {} }), /not deleted: HTTP 503/);
  assert.equal(calls.length, 2);
});
