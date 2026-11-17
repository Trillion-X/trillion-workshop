import test from 'node:test';
import assert from 'node:assert/strict';
import { keptReceipts, receiptStore } from '../read-data/door-receipts.mjs';

test('receipts are held in the run and answered; one handed in is read back, and a bad name is refused', async () => {
  const kept = keptReceipts({ 'lease-a': { state: 'running' } });
  assert.deepEqual(await kept.read('lease-a'), { state: 'running' });
  assert.equal(await kept.read('lease-b'), null);
  await kept.save('lease-b', { state: 'creating' });
  assert.deepEqual(kept.all(), { 'lease-a': { state: 'running' }, 'lease-b': { state: 'creating' } });
  await assert.rejects(kept.save('Not A Name', {}), /lower-case words joined by dashes/);
});

test('a receipt is a lease store: it reads and saves the one receipt it names', async () => {
  const kept = keptReceipts({ 'lease-a': { state: 'running' } }), store = receiptStore(kept, 'lease-a');
  assert.deepEqual(await store.read(), { state: 'running' });
  await store.save({ state: 'removed' });
  assert.deepEqual(kept.all(), { 'lease-a': { state: 'removed' } });
  assert.equal(await receiptStore(kept, 'lease-none').read(), null);
});
