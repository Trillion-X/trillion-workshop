import test from 'node:test';
import assert from 'node:assert/strict';
import { resultsPerPrice } from '../read-data/read-results-per-price.mjs';

const states = {
  'share_1': { opened: true, signed: true, paid: true },
  'share_2': { opened: true, signed: false, paid: false },
  'share_3': null,
};
const linkStateOf = (record, shareId) => states[shareId] ?? null;

test('each price arm counts its own sent, opened, signed and paid sends', () => {
  const sends = [
    { record: 'sales-contract:a', share_id: 'share_1', sent: true, arm: { arm: 'low', amount_cents: 2900 } },
    { record: 'sales-contract:a', share_id: 'share_2', sent: true, arm: { arm: 'low', amount_cents: 2900 } },
    { record: 'sales-contract:a', share_id: 'share_3', sent: true, arm: { arm: 'high', amount_cents: 4900 } },
    { record: 'sales-contract:a', sent: false, arm: { arm: 'high', amount_cents: 4900 } },
  ];
  assert.deepEqual(resultsPerPrice({ sends, linkStateOf }), [
    { arm: 'low', amount_cents: 2900, sent: 2, opened: 2, signed: 1, paid: 1 },
    { arm: 'high', amount_cents: 4900, sent: 1, opened: 0, signed: 0, paid: 0 },
  ]);
});

test('a send with no price arm is counted under no arm', () => {
  const sends = [{ record: 'note:n1', share_id: 'share_2', sent: true, arm: null }];
  assert.deepEqual(resultsPerPrice({ sends, linkStateOf }), [
    { arm: null, amount_cents: null, sent: 1, opened: 1, signed: 0, paid: 0 },
  ]);
});

test('no sends gives no rows', () => {
  assert.deepEqual(resultsPerPrice({ sends: [], linkStateOf }), []);
});
