// A case write the door kept (`pending`) is read to its outcome by its key, and a refusal the writer gives reaches the
// caller as a thrown error, never as a kept case. Synthetic doors only: no record of anyone's is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import settings from '../read-data/decide-with-a-method.json' with { type: 'json' };
import { settledWrite, writeDecision, WRITE_PENDING } from '../read-data/decision-records.mjs';

const noWait = async () => {};
const refusal = () => Object.assign(new Error('refused'), { code: 'command_settle_mismatch' });

// A door that keeps its first write pending, then answers whatever `then` says for the same key.
function doorThen(then) {
  const keys = [];
  return {
    keys,
    door: {
      async write(records, { key }) {
        keys.push(key);
        if (keys.length === 1) return { accepted: true, pending: true, request_key: key };
        return then(records, key);
      },
    },
  };
}

test('a pending write is read again by its key until the writer settles it as committed', async () => {
  const { door, keys } = doorThen(() => ({ accepted: true, committed: true }));
  const answer = await settledWrite(door, [{ id: 'decision:a', type: 'decision', value: {} }], 'k', noWait);
  assert.deepEqual(answer, { accepted: true, committed: true });
  assert.deepEqual(keys, ['k', 'k'], 'the same key answers the outcome');
});

test('a writer refusal after a pending write is thrown to the caller, never reported as kept', async () => {
  const { door, keys } = doorThen(() => { throw refusal(); });
  await assert.rejects(settledWrite(door, [{ id: 'decision-revision:a', type: 'decision-revision', value: {} }], 'k', noWait),
    { code: 'command_settle_mismatch' });
  assert.equal(keys.length, 2);
});

test('a write still pending when the settle window has passed is thrown, not reported as kept', async () => {
  const keys = [];
  const door = { async write(_records, { key }) { keys.push(key); return { accepted: true, pending: true, request_key: key }; } };
  await assert.rejects(settledWrite(door, [], 'k', noWait), { code: WRITE_PENDING });
  assert.equal(keys.length, Math.floor(settings.settle.wait_ms / settings.settle.poll_ms) + 1);
});

test('a decision write whose pending write the writer refuses fails the step', async () => {
  const list = [
    { id: 'decision:a', type: 'decision', value: { id: 'a' } },
    { id: 'decision-revision:a', type: 'decision-revision', value: { revision: 1 } },
  ];
  const { door } = doorThen(() => { throw refusal(); });
  await assert.rejects(writeDecision(door, list, 'start-a-decision:a', noWait), { code: 'command_settle_mismatch' });
});
