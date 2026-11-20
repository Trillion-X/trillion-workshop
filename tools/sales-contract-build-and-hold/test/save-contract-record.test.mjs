import test from 'node:test';
import assert from 'node:assert/strict';
import { saveContractRecord } from '../read-data/save-contract-record.mjs';

const at = '2026-11-10T09:00:00.000Z';
const newId = () => 'f00d';

test('a new contract gets a sales-contract id, draft status and the same created and updated time', () => {
  const { id, record } = saveContractRecord({ input: { contract: { name: '  Studio retainer  ' } }, rows: [], at, newId });
  assert.equal(id, 'sales-contract:f00d');
  assert.equal(record.kind, 'sales-contract');
  assert.equal(record.status, 'draft');
  assert.equal(record.name, 'Studio retainer');
  assert.equal(record.created_at, at);
  assert.equal(record.updated_at, at);
});

test('a given contract_id is kept as the id', () => {
  const { id } = saveContractRecord({ input: { contract_id: 'sales-contract:abc', contract: { name: 'A' } }, rows: [], at, newId });
  assert.equal(id, 'sales-contract:abc');
});

test('saving over an earlier contract keeps its created time and share id', () => {
  const rows = [{ id: 'sales-contract:abc', created_at: '2026-10-01T00:00:00.000Z', share_id: 'share_1' }];
  const { record } = saveContractRecord({ input: { contract_id: 'sales-contract:abc', contract: { name: 'A' } }, rows, at, newId });
  assert.equal(record.created_at, '2026-10-01T00:00:00.000Z');
  assert.equal(record.share_id, 'share_1');
  assert.equal(record.updated_at, at);
});

test('a removed earlier contract is not kept: the save is new', () => {
  const rows = [{ id: 'sales-contract:abc', created_at: '2026-10-01T00:00:00.000Z', share_id: 'share_1', removed_at: '2026-10-02T00:00:00.000Z' }];
  const { record } = saveContractRecord({ input: { contract_id: 'sales-contract:abc', contract: { name: 'A' } }, rows, at, newId });
  assert.equal(record.created_at, at);
  assert.equal('share_id' in record, false);
});

test('the stored contract is a copy of the terms supplied', () => {
  const terms = { name: 'A', primitives: [] };
  const { record } = saveContractRecord({ input: { contract: terms }, rows: [], at, newId });
  assert.notEqual(record.contract, terms);
  assert.deepEqual(record.contract, terms);
});

test('the checks refuse with the old owner words', () => {
  assert.throws(() => saveContractRecord({ input: 'x', rows: [], at, newId }), { message: 'Give { contract } to save a sales contract.' });
  assert.throws(() => saveContractRecord({ input: { contract: 'x' }, rows: [], at, newId }), { message: 'Give the contract terms as an object.' });
  assert.throws(() => saveContractRecord({ input: { contract: { name: '   ' } }, rows: [], at, newId }), { message: 'Give the contract a name.' });
  assert.throws(() => saveContractRecord({ input: { contract: { name: 'A', primitives: 'x' } }, rows: [], at, newId }), { message: 'Contract primitives must be a list.' });
});
