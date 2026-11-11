// tools/deliver-to-list/test/deliver-to-list.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowFor, answerFor } from '../do-work/deliver-to-list.mjs';

const input = { row_type: 'sign-in-code', to: 'a@example.com', subject: 'Your code', text: '123456', kind: 'sign-in-code', idempotencyKey: 'k1' };

test('a message is one row whose id is its idempotency key and whose type is the list row type', () => {
  const row = rowFor(input, '2026-11-10T00:00:00.000Z');
  assert.equal(row.id, 'k1');
  assert.equal(row.type, 'record:sign-in-code');
  assert.deepEqual(row.value, { to: 'a@example.com', subject: 'Your code', text: '123456', kind: 'sign-in-code', at: '2026-11-10T00:00:00.000Z' });
});

test('a missing field is refused by name', () => {
  assert.throws(() => rowFor({ ...input, to: ' ' }, 'now'), /to is required/);
});

test('a written row answers the message id the engine reads', () => {
  assert.deepEqual(answerFor({ written: true, id: 'k1' }), { sent: [{ messageId: 'k1' }] });
});

test('a refusal answers its words with unknown false, and a maybe-written row answers unknown', () => {
  assert.deepEqual(answerFor({ written: false, error: 'no' }), { sent: [{ error: 'no' }], unknown: false });
  assert.deepEqual(answerFor({ written: false, unknown: true }), { sent: [{ unknown: true }], unknown: true });
});
