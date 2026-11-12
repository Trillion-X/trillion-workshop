// A decision's writes go through the shared records client, so a write the door keeps (`pending`) is read to its outcome:
// a refusal the writer gives later fails the step, and a decision is never reported as kept while its write is pending.
// Synthetic calls only: no record of anyone's is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeDecision } from '../read-data/decision-records.mjs';
import { recordsDoorFromCall, RecordsDoorError } from '../../records-door/read-data/records-door.mjs';

const noWait = async () => {};

test('a decision write whose pending write the writer refuses fails the step', async () => {
  const list = [
    { id: 'decision:a', type: 'decision', value: { id: 'a' } },
    { id: 'decision-revision:a', type: 'decision-revision', value: { revision: 1 } },
  ];
  let asked = 0;
  const door = recordsDoorFromCall(async () => {
    asked += 1;
    if (asked === 1) return { accepted: true, pending: true };
    throw new RecordsDoorError('command_settle_mismatch', 'refused', 'not_started');
  }, { resource: '@own-records', wait: noWait });
  await assert.rejects(writeDecision(door, list, 'start-a-decision:a'), { code: 'command_settle_mismatch' });
  assert.equal(asked, 2);
});
