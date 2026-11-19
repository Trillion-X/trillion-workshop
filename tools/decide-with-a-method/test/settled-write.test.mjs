import { heldOf, memoryDoor } from './fixtures.mjs';
// A decision's writes are kept by its caller, not written by the tool: writeDecision answers each record with the value the
// store must still hold for it (`expected`), and a store that no longer holds that value refuses the whole write, so no
// part of a decision lands over a record that moved. Synthetic records only: no record of anyone's is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeDecision } from '../read-data/decision-records.mjs';

test('a decision write is kept with the value each record must still hold, and a write whose record moved is refused whole', () => {
  const door = memoryDoor();
  door.put('decision:a', 'decision', { id: 'a', status: 'needs_decision' });
  const list = [
    { id: 'decision:a', type: 'decision', value: { id: 'a', status: 'needs_outcome' } },
    { id: 'decision-revision:a', type: 'decision-revision', value: { revision: 1 } },
  ];
  const kept = writeDecision(heldOf(door), list);
  assert.deepEqual(kept.map(record => record.id), ['decision-revision:a', 'decision:a']);
  assert.equal(kept.find(record => record.id === 'decision-revision:a').expected, null, 'a record the store does not hold is expected absent');
  assert.deepEqual(kept.find(record => record.id === 'decision:a').expected, { type: 'decision', value: { id: 'a', status: 'needs_decision' } });
  door.put('decision:a', 'decision', { id: 'a', status: 'ended' });
  assert.throws(() => door.write(kept), error => error.code === 'original_command_conflict');
  assert.equal(door.value('decision-revision:a'), null, 'nothing landed');
  assert.equal(door.value('decision:a').status, 'ended');
});
