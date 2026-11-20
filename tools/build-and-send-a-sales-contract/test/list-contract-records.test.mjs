import test from 'node:test';
import assert from 'node:assert/strict';
import { currentContractRows, listContractRecords } from '../read-data/list-contract-records.mjs';

const rows = [
  { id: 'sales-contract:a', name: 'A', updated_at: '2026-11-01T10:00:00.000Z' },
  { id: 'sales-contract:b', name: 'B', updated_at: '2026-11-03T10:00:00.000Z' },
  { id: 'sales-contract:c', name: 'C', updated_at: '2026-11-02T10:00:00.000Z', removed_at: '2026-11-04T10:00:00.000Z' },
  { name: 'no id', updated_at: '2026-11-05T10:00:00.000Z' },
  null,
  'not a row',
];

test('the list holds only contract rows that are not removed, newest first', () => {
  const answer = listContractRecords(rows);
  assert.deepEqual(answer.contracts.map(row => row.id), ['sales-contract:b', 'sales-contract:a']);
  assert.equal(answer.count, 2);
});

test('a removed row is left out of the current rows', () => {
  assert.deepEqual(currentContractRows(rows).map(row => row.id), ['sales-contract:a', 'sales-contract:b']);
});

test('an empty account lists nothing', () => {
  assert.deepEqual(listContractRecords([]), { contracts: [], count: 0 });
});
