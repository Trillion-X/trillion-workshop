// The decision tool rows reach no records door. A row takes the records it reads as `records` (read by its caller from
// the person's own store) and answers the changes as `keep`, so no row declares rights to a store and no row's text or
// samples name a records operation. Each write row answers its changes with the value each record was expected to hold.
import { rightsOf } from '../../../test-helpers/run-a-row.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startADecision } from '../read-data/decisions.mjs';
import { METHOD_VIEW, run, methodAccount, memoryDoor } from './fixtures.mjs';

const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(row => row.payload);
const OPERATION = /records?:(read|list|write)\b/;

test('no decision tool row declares rights to a store', () => {
  for (const row of rows) assert.deepEqual(rightsOf(row), [], `${row.id} declares rights to a store`);
});

test('no decision tool row names a records operation in its text, schemas or samples', () => {
  for (const row of rows) assert.doesNotMatch(JSON.stringify(row), OPERATION, `${row.id} names a records operation`);
});

test('a decision opened from the records handed in keeps each record with the value it expected', () => {
  const door = methodAccount(memoryDoor());
  const answer = run(door, startADecision, {
    source_id: 'chat:rows', goal: 'Decide the made-up goal', evidence: [{ ref: 'e1', claim: 'A made-up claim' }],
    options: [{ id: 'keep', label: 'Keep' }, { id: 'raise', label: 'Raise' }], method: METHOD_VIEW,
  });
  assert.ok(answer.keep.length >= 2, 'the root and its revision are kept');
  for (const record of answer.keep) assert.ok('expected' in record, `${record.id} carries its expected value`);
  assert.equal(answer.keep.at(-1).type, 'decision', 'the root is kept last');
});
