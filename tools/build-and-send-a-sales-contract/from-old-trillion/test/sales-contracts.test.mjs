import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeSalesContracts } from '../src/sales-contracts.mjs';
import { readToolData } from 'trillion-workshop/tools/ai-tool-catalog/read-data/read-ai-tool-catalog.ts';

const recordSet = JSON.parse(readFileSync(new URL('../../../draft-and-send-a-sales-contract-to-a-customer-from/from-old-trillion/records/workshop-sales-contract-tool-records.json', import.meta.url), 'utf8'));
const placements = JSON.parse(readFileSync(new URL('../../../pick-where-one-piece-of-work-runs-the-device/records/workshop-placement-records.json', import.meta.url), 'utf8'));
const accountTools = JSON.parse(readFileSync(new URL('../../../keep-and-wake-ai-sessions-on-this-computer/records/workshop-account-tool-records.json', import.meta.url), 'utf8'));

test('Workshop exposes a single account-owned tool with a human screen and flexible negotiated terms', () => {
  const { tools, placements: decodedPlacements } = readToolData([
    ...recordSet.records.map(record => ({ payload: record.payload })),
    ...placements.records.map(record => ({ payload: record.payload })),
    ...accountTools.records.map(record => ({ payload: record.payload })),
  ]);
  const tool = tools.find(row => row.id === 'tool:manage-sales-contracts');
  assert.ok(tool);
  assert.equal(tool.invoke.action, 'sales-contracts');
  assert.deepEqual(tool.placements, ['placement:this-account']);
  assert.equal(tool.screen.entry, 'sales-contract-builder');
  assert.ok(decodedPlacements.some(row => row.id === 'placement:this-account'));
  assert.equal(JSON.stringify(tool).includes('1500'), false, 'the tool descriptor carries no example price');
});

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
