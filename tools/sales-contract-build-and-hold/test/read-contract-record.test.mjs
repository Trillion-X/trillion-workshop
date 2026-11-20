import test from 'node:test';
import assert from 'node:assert/strict';
import { readContractRecord } from '../read-data/read-contract-record.mjs';

const rows = [
  { id: 'sales-contract:a', name: 'A' },
  { id: 'sales-contract:gone', name: 'Gone', removed_at: '2026-11-01T00:00:00.000Z' },
];

test('a current contract is read by its id', () => {
  assert.equal(readContractRecord(rows, 'sales-contract:a').name, 'A');
});

test('a removed contract reads as no contract', () => {
  assert.throws(() => readContractRecord(rows, 'sales-contract:gone'), { message: 'There is no sales contract sales-contract:gone in this account.' });
});

test('a missing id is named as having no id', () => {
  assert.throws(() => readContractRecord(rows, undefined), { message: 'There is no sales contract with no id in this account.' });
  assert.throws(() => readContractRecord(rows, ''), { message: 'There is no sales contract with no id in this account.' });
});

test('an id with a $ in it is kept as written in the refusal', () => {
  assert.throws(() => readContractRecord(rows, 'sales-contract:$&'), { message: 'There is no sales contract sales-contract:$& in this account.' });
});
