import test from 'node:test';
import assert from 'node:assert/strict';
import { makeContractStoreAdapter } from '../read-data/contract-store-adapter.mjs';

test('list reads the values under the sales-contract prefix', () => {
  const asked = [];
  const store = makeContractStoreAdapter({ readValuesWithPrefix: prefix => { asked.push(prefix); return [{ id: 'sales-contract:a' }]; }, writeValue: () => {} });
  assert.deepEqual(store.list(), [{ id: 'sales-contract:a' }]);
  assert.deepEqual(asked, ['sales-contract:']);
});

test('put writes the value under its contract id', () => {
  const writes = [];
  const store = makeContractStoreAdapter({ readValuesWithPrefix: () => [], writeValue: (id, value) => writes.push([id, value]) });
  store.put('sales-contract:b', { id: 'sales-contract:b' });
  assert.deepEqual(writes, [['sales-contract:b', { id: 'sales-contract:b' }]]);
});

test('an account store without both functions is refused with the old words', () => {
  assert.throws(() => makeContractStoreAdapter({ readValuesWithPrefix: () => [] }), { name: 'TypeError', message: 'Sales contracts need the account store that owns their records.' });
});
