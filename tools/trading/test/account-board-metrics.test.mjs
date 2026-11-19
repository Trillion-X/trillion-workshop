// tools/trading/read-data/account-board.ts formatAccountMetric: each shape a metric descriptor names draws its value;
// a descriptor with no shape is money, and a shape the formatter does not draw shows the value as it is (never dollars).
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAccountMetric } from '../read-data/account-board.ts';

test('each drawn shape formats its value, and no shape is money', () => {
  assert.equal(formatAccountMetric(1234.5, {}).value, formatAccountMetric(1234.5, { shape: 'money' }).value);
  assert.match(formatAccountMetric(1234.5, { shape: 'money' }).value, /\$/);
  assert.equal(formatAccountMetric(12.6, { shape: 'integer' }).value, '13');
  assert.equal(formatAccountMetric(-5, { shape: 'signed-money' }).tone, 'error');
  assert.equal(formatAccountMetric('A note', { shape: 'text' }).value, 'A note');
});

test('a shape the formatter does not draw shows the value as it is, not as dollars', () => {
  const shown = formatAccountMetric(42, { shape: 'basis-points' });
  assert.equal(shown.value, '42');
  assert.equal(shown.tone, 'neutral');
  assert.equal(formatAccountMetric(null, { shape: 'basis-points' }).value, '—');
});
