import test from 'node:test';
import assert from 'node:assert/strict';
import { observeLiveUsage, liveReadings, readUsageDays } from '../do-work/live-usage.mjs';
import { settleSharedResourceCost, manageUsagePricing, priceResourceUsage } from '../do-work/resource-usage.mjs';
import { compareAmounts, multiplyAmounts, addAmounts } from '../read-data/resource-usage.mjs';
import { readFileSync } from 'node:fs';

const meters = JSON.parse(readFileSync(new URL('../read-data/usage-meters.json', import.meta.url), 'utf8'));
const equal = (actual, expected) => assert.equal(compareAmounts(actual, expected), 0, `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
const key = resource_id => ({ supplier_pool: 'pool:synthetic', tariff_version: 'tariff:test', cost_class: resource_id, invoice_period: '2026-11', currency: 'usd', resource_id });

// The engine's own day rows, field for field as trillion-rust src/namespace/usage.rs `add_to_day` writes them and the
// files door's usage_days answers them (one page, then a second page, as a long history pages).
const engineRows = [
  { kind: 'namespace-usage-day', day: '2026-11-01', stored_bytes: 2500000000, stored_bytes_written: 2500000000, source_bytes_read: 4096, work_ms: 1200, tool_runs: 3, flushes: 4, updated_at: '2026-11-01T23:55:00.000Z' },
  { kind: 'namespace-usage-day', day: '2026-11-02', stored_bytes: 2500000000, stored_bytes_written: 0, source_bytes_read: 0, work_ms: 0, tool_runs: 0, flushes: 1, updated_at: '2026-11-02T00:05:00.000Z' },
  { kind: 'namespace-usage-day', day: '2026-11-03', stored_bytes: 2600000000, stored_bytes_written: 100000000, source_bytes_read: 10, work_ms: 5, tool_runs: 1, flushes: 1, updated_at: '2026-11-03T12:00:00.000Z' },
];

function memoryDoor(rows = engineRows) {
  const records = new Map(); const keys = new Map(); const calls = [];
  return { calls, records, door: {
    async read(type, id) { const row = records.get(id); return row?.type === type ? structuredClone(row.value) : null; },
    async *list({ type, reverse } = {}) { if (!reverse) throw new Error('descending only'); for (const [id, row] of [...records].sort(([a], [b]) => b.localeCompare(a))) if (row.type === type) yield { id, ...structuredClone(row) }; },
    async write(rows, { key: requestKey } = {}) {
      if (keys.has(requestKey)) return keys.get(requestKey);
      for (const row of rows) if (Object.hasOwn(row, 'expected')) assert.deepEqual(records.get(row.id) ?? null, row.expected);
      for (const row of rows) records.set(row.id, { type: row.type, value: structuredClone(row.value) });
      keys.set(requestKey, { changed: true }); return { changed: true };
    },
    async files(method, input) {
      calls.push({ method, input });
      assert.equal(method, 'usage_days');
      const start = input.after ? rows.findIndex(row => row.day === input.after) + 1 : 0;
      const page = rows.slice(start, start + 2);
      return { days: page, next_after: start + 2 < rows.length ? page.at(-1).day : null, stored_bytes_now: rows.at(-1).stored_bytes };
    },
  } };
}

test('the three billed resources read the engine row fields the old meters named', () => {
  const readings = liveReadings();
  assert.deepEqual(Object.keys(readings), ['meter:stored-gigabytes', 'meter:service-work', 'resource:source-bytes']);
  assert.equal(readings['meter:stored-gigabytes'].row_field, 'stored_bytes');
  assert.equal(readings['meter:service-work'].row_field, 'work_ms');
  assert.equal(readings['resource:source-bytes'].row_field, 'source_bytes_read');
  // Ported one to one: the margin and the default markup are the old file's.
  assert.deepEqual(meters.meters.map(row => row.cost.margin), [1.3, 1.3]);
  assert.equal(meters.resource_pricing.default_rule.markup_percent, '30');
});

test('usage days page through the files door', async () => {
  const { door, calls } = memoryDoor();
  assert.deepEqual((await readUsageDays(door)).map(row => row.day), ['2026-11-01', '2026-11-02', '2026-11-03']);
  assert.equal(calls.length, 2);
});

test('closed live days become immutable observations and settle at cost x 1.3 with the ported default rule', async () => {
  const { door, records } = memoryDoor();
  const resources = Object.keys(liveReadings());
  const settlement_keys = Object.fromEntries(resources.map(id => [id, key(id)]));
  await assert.rejects(observeLiveUsage({ payer_id: 'payer:synthetic', day_from: '2026-11-01', day_to: '2026-11-03', today: '2026-11-03', settlement_keys, request_key: 'r' }, { door }), /closed days/);
  const observed = await observeLiveUsage({ payer_id: 'payer:synthetic', day_from: '2026-11-01', day_to: '2026-11-01', today: '2026-11-03', settlement_keys, request_key: 'live-1' }, { door });
  assert.deepEqual(observed.missing_days, []);
  equal(observed.quantities['meter:stored-gigabytes']['2026-11-01'], '2.5');
  equal(observed.quantities['meter:service-work']['2026-11-01'], '1200');
  equal(observed.quantities['resource:source-bytes']['2026-11-01'], '4096');
  // The same request again keeps the same observations; nothing is counted twice.
  const again = await observeLiveUsage({ payer_id: 'payer:synthetic', day_from: '2026-11-01', day_to: '2026-11-01', today: '2026-11-03', settlement_keys, request_key: 'live-1' }, { door });
  assert.deepEqual(again.observation_refs, observed.observation_refs);
  assert.equal([...records.values()].filter(row => row.type === 'resource-usage-observation').length, 3);

  // The seller's rule is the ported default (+30%); prices are rows, never engine data.
  const rule = { ...meters.resource_pricing.default_rule };
  await manageUsagePricing({ action: 'save', rule_id: rule.id, expected_version: 0, request_key: 'default-rule', rule }, { door });
  // Synthetic supplier invoices for that day: what each pool cost Trillion.
  const invoices = { 'meter:stored-gigabytes': '0.00125', 'meter:service-work': '0.0006', 'resource:source-bytes': '0.000004' };
  let total = { n: '0', d: '1' };
  for (const id of resources) {
    const { terms } = await priceResourceUsage({ at: '2026-11-02T00:00:00Z', resource_id: id }, { door });
    assert.equal(terms.markup_bps, '3000');
    const settled = await settleSharedResourceCost({
      request_key: `settle:${id}`, settlement_id: `synthetic:${id}:2026-11-01`, settlement_key: key(id),
      invoice: { status: 'confirmed', amount: invoices[id], evidence_ref: `invoice:synthetic:${id}` },
      payers: [{ payer_id: 'payer:synthetic', kind: 'customer', max_unit_cost: '1', authorized_total: '100', terms }],
      observation_refs: observed.observation_refs[id],
    }, { door });
    equal(settled.settlement.result.customer_supplier_cost, invoices[id]);
    equal(settled.settlement.result.customer_charged, multiplyAmounts(invoices[id], '1.3'));
    total = addAmounts(total, settled.settlement.result.customer_charged);
  }
  equal(total, multiplyAmounts('0.001854', '1.3'));
});

test('included units come off before excess, and a day the engine never wrote is named, never zero', async () => {
  const { door } = memoryDoor([engineRows[0]]);
  const settlement_keys = { 'resource:source-bytes': key('resource:source-bytes') };
  const observed = await observeLiveUsage({ payer_id: 'payer:p', day_from: '2026-11-01', day_to: '2026-11-02', today: '2026-11-03', settlement_keys, included_units: { 'resource:source-bytes': '96' }, request_key: 'k' }, { door });
  assert.deepEqual(observed.missing_days, ['2026-11-02']);
  assert.deepEqual(Object.keys(observed.observation_refs), ['resource:source-bytes']);
  const value = await door.read('resource-usage-observation', observed.observation_refs['resource:source-bytes'][0]);
  equal(value.source_units, '4096'); equal(value.excess_units, '4000');
});
