// tools/build-and-send-a-sales-contract/test/sales-contract-records.test.mjs
// The sales contract store (do-work/sales-contract-records.mjs): save, list and read contract records with the caller's terms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSalesContracts } from '../do-work/sales-contract-records.mjs';

test('sales contract records keep caller-supplied prices and schedules without imposing a price or term', () => {
  const rows = new Map();
  let clock = 0;
  const contracts = makeSalesContracts({
    store: { list: () => [...rows.values()], put: (id, row) => rows.set(id, row) },
    now: () => `2026-09-30T00:00:0${clock++}Z`,
    id: () => 'draft-1',
  });

  assert.deepEqual(contracts.list(), { contracts: [], count: 0 });
  const negotiated = { name: 'Casey CPG engagement', primitives: [
    { type: 'Commitment', label: 'Services', amount: 125000, currency: 'USD', recurrence: 'monthly', metadata: { duration_months: 3 } },
    { type: 'GrantAccess', label: 'Included calls', resource: 'consulting-call', condition: 'usage_based', usage_limit: 4 },
  ] };
  const saved = contracts.save({ contract: negotiated });
  assert.equal(saved.id, 'sales-contract:draft-1');
  assert.deepEqual(saved.contract, negotiated);
  const updated = contracts.save({ contract_id: saved.id, contract: { name: 'Updated terms', pricing_rules: [{ kind: 'negotiated', amount_cents: 86000, interval: 'month', duration: 2 }] } });
  assert.equal(updated.created_at, saved.created_at);
  assert.deepEqual(contracts.read(saved.id), updated);
  assert.deepEqual(contracts.list().contracts, [updated]);
  assert.throws(() => contracts.save({ contract: { primitives: [] } }), /Give the contract a name/);
  assert.throws(() => contracts.read('unknown'), /There is no sales contract/);
});
