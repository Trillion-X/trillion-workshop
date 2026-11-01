import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPriceSource } from '../read-data/provider-prices.mjs';

test('price projection retains the billable unit and rate basis', () => {
  const result = projectPriceSource({
    format: 'provider-price-source/1', source_revision: 'book-1', observed_at: '2026-10-31',
    sources: [{ id: 'official', url: 'https://example.test/rates' }],
    unit_rates: [{ id: 'rate-1', provider: 'host-a', meter: 'requests', rate: 0.3, per: 1000, unit: 'request', currency: 'USD', source_id: 'official', source_revision: 'rate-1', evaluator_eligible: true, billing_model: 'unconditional-unit-rate' }],
  });
  assert.deepEqual(result.prices[0], {
    provider: 'host-a', meter: 'requests', unit: 'request', amount: 0.0003, currency: 'USD', source_revision: 'rate-1',
    source_id: 'official', source_url: 'https://example.test/rates', basis: undefined,
  });
});
