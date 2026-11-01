import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import rows from '../tool-rows.json' with { type: 'json' };
import { runRow } from '../../records-door/test/run-row.mjs';
import { collectAndRefresh } from '../read-data/collect.mjs';

test('direct wake consumer persists and resumes through the actual shared process row without creating an AI job', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'direct-measurement-wake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), receipts = path.join(root, 'receipts');
  await mkdir(source); await mkdir(receipts);
  await writeFile(path.join(source, 'tool-rows.json'), JSON.stringify({ kind: 'tool-rows', records: [{ payload: { kind: 'ai-tool-descriptor', id: 'tool:sample' } }] }));
  const sourceRoots = [{ id: 'system', path: source }];
  const pin = await collectAndRefresh({ source_roots: sourceRoots, receipt_roots: [], meters: [], prices: [] });
  await writeFile(path.join(receipts, 'run.json'), JSON.stringify({ schema: 'execution-observation/1', id: 'physical-1', operation: 'tool:sample', source: 'system', source_revision: pin.discovery.source_roots[0].revision, provider: 'fixture', at: '2026-10-31T12:00:00-06:00', useful_work: { status: 'succeeded' }, measurements: [{ meter: 'requests', unit: 'request', value: 3 }] }));
  const meters = path.join(root, 'meters.json'), prices = path.join(root, 'prices.json');
  await writeFile(meters, JSON.stringify([{ id: 'requests', unit: 'request', aggregation: 'sum', required_for_all_operations: true }]));
  await writeFile(prices, JSON.stringify({ format: 'provider-price-source/1', source_revision: 'fixture-price-1', observed_at: '2026-10-31', sources: [{ id: 'test', url: 'https://example.test/prices' }], unit_rates: [{ id: 'requests', provider: 'fixture', meter: 'requests', rate: 1, per: 10, unit: 'request', currency: 'USD', source_id: 'test', source_revision: 'fixture-price-1', evaluator_eligible: true, billing_model: 'unconditional-unit-rate' }] }));
  const config = { id: 'measurement-source-config:default', type: 'measurement_source_config', value: { schema: 'measurement-source-config/1', source_roots: sourceRoots, receipt_roots: [{ id: 'system', source_id: 'system', path: receipts }], meter_book: { path: meters }, price_book: { source_tool: 'tool:refresh-provider-prices', path: prices } } };
  const row = structuredClone(rows.records.find(r => r.payload.id === 'tool:refresh-measurement-history').payload);
  // The real native computer runner supplies this task grant; the shared test process receives its fixture grant.
  row.invoke.argv[4] = root; row.invoke.argv[5] = 'fixture-native-request';
  const first = await runRow(row, {}, { records: [config] });
  assert.equal(first.status, 0);
  assert.ok(first.result.appended.inserted > 0);
  assert.equal(first.result.forecast.saved, true);
  assert.equal(first.result.ai_jobs_created, 0);
  assert.equal(first.kept.some(r => r.type === 'ai-job'), false);
  assert.equal(first.result.coverage.total_cost, null);
  assert.equal(first.result.coverage.component_total, 0.30000000000000004);
  assert.equal(first.result.physical_refresh.appended.inserted, 5);
  const second = await runRow(row, {}, { records: first.kept });
  assert.equal(second.status, 0);
  assert.equal(second.result.appended.inserted, 0);
  assert.ok(second.result.appended.replayed > 0);
  assert.equal(second.result.forecast.replayed, true);
  // A new actual child process is physical work even when its evidence inputs are unchanged.
  assert.equal(second.result.physical_refresh.appended.inserted, 5);
  assert.notEqual(second.result.physical_refresh.invocation, first.result.physical_refresh.invocation);
  assert.equal(second.kept.length, first.kept.length + 5);
});
