import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../do-work/keep-measurements-current.mjs';
import { validateSourceConfig } from '../read-data/source-config.mjs';
import { collectAndRefresh } from '../read-data/collect.mjs';

async function fixture(t) {
  const base = tempFolder(path.join(os.tmpdir(), 'measurement-source-config-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const receipts = path.join(base, 'receipts');
  await mkdir(source); await mkdir(receipts);
  const meterBook = path.join(base, 'meters.json');
  const meter = { id: 'vendor.request_ms', unit: 'ms', aggregation: 'duration', required_for_all_operations: true };
  await writeFile(meterBook, JSON.stringify([meter]));
  const catalogPath = path.join(source, 'what-this-tool-does-and-how-to-run-it.json');
  await writeFile(catalogPath, JSON.stringify({ kind: 'tool-rows', records: [{ payload: { kind: 'ai-tool-descriptor', id: 'tool:sample-operation' } }] }));
  await writeFile(path.join(receipts, 'run.json'), JSON.stringify({
    schema: 'execution-observation/1', id: 'run-1', operation: 'tool:sample-operation', source: 'local',
    source_revision: 'ignored-upstream-claim', provider: 'provider-x', at: '2026-10-31T12:00:00Z', attempt: 1,
    useful_work: { status: 'succeeded' }, measurements: [{ meter: meter.id, unit: meter.unit, value: 25 }],
  }));
  const config = {
    schema: 'measurement-source-config/1',
    source_roots: [{ id: 'workshop', path: source }],
    receipt_roots: [{ id: 'workshop', path: receipts, source_id: 'workshop' }],
    meter_book: { path: meterBook },
    price_book: { source_tool: 'tool:refresh-provider-prices' },
  };
  const pinned = await collectAndRefresh({ source_roots: config.source_roots, receipt_roots: [], meters: [], prices: [] });
  const observed = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(receipts, 'run.json'), 'utf8'));
  observed.source_revision = pinned.discovery.source_roots.find(s => s.id === 'workshop').revision;
  await writeFile(path.join(receipts, 'run.json'), JSON.stringify(observed));
  return { base, source, catalogPath, config };
}

test('the source config handed in the request drives a real bounded collection, and the answer holds the collection', async t => {
  const f = await fixture(t);
  const prices = { format: 'provider-price-input/1', source_revision: 'book-7', observed_at: '2026-10-31', prices: [{ meter: 'vendor.request_ms', unit: 'ms', provider: 'provider-x', amount: 0.02, currency: 'USD', source_revision: 'book-7' }], excluded: [] };
  const result = await run({ action: 'collect_from_config', config: f.config, prices }, { grantedFolder: f.base });
  const row = result.coverage.rows.find(r => r.operation === 'tool:sample-operation');
  assert.equal(row.status, 'measured');
  assert.equal(row.value, 25);
  assert.equal(row.cost, 0.5);
  assert.equal(row.currency, 'USD');
  assert.ok(result.discovery.complete);
  assert.deepEqual(result.discovery.operation_catalog.map(x => x.id), ['tool:sample-operation']);

  await writeFile(f.catalogPath, JSON.stringify({ kind: 'tool-rows', records: [
    { payload: { kind: 'ai-tool-descriptor', id: 'tool:sample-operation' } },
    { payload: { kind: 'ai-tool-descriptor', id: 'tool:added-after-setup' } },
  ] }));
  const changed = await run({ action: 'collect_from_config', config: f.config, prices, prior: result.refresh_state }, { grantedFolder: f.base });
  assert.equal(changed.coverage.stale_sources, true);
  assert.equal(changed.coverage.rows.find(r => r.operation === 'tool:sample-operation').cost, null);
  assert.equal(changed.coverage.rows.find(r => r.operation === 'tool:sample-operation').status, 'stale-source-observation');
  assert.ok(changed.coverage.operations.includes('tool:added-after-setup'));
  assert.equal(changed.coverage.rows.find(r => r.operation === 'tool:added-after-setup').value, null);
  assert.equal(changed.coverage.rows.find(r => r.operation === 'tool:added-after-setup').cost, null);
});

test('a price-book revision invalidates prior coverage even when its eligible rows stay the same', async t => {
  const f = await fixture(t);
  const priceRows = [{ meter: 'vendor.request_ms', unit: 'ms', provider: 'provider-x', amount: 0.02, currency: 'USD', source_revision: 'rate-unchanged' }];
  const firstPrices = { format: 'provider-price-input/1', source_revision: 'book-7', observed_at: '2026-10-31', prices: priceRows, excluded: [] };
  const first = await run({ action: 'collect_from_config', config: f.config, prices: firstPrices }, { grantedFolder: f.base });
  const changedBook = { ...firstPrices, source_revision: 'book-8', observed_at: '2026-11-01' };
  const second = await run({ action: 'collect_from_config', config: f.config, prices: changedBook, prior: first.refresh_state }, { grantedFolder: f.base });
  assert.equal(second.coverage.stale_sources, true);
  assert.notEqual(second.coverage.pins.prices, first.coverage.pins.prices);
});

test('a missing or malformed account config cannot start a collection', async t => {
  const f = await fixture(t);
  await assert.rejects(run({ action: 'collect_from_config', prices: [] }, { grantedFolder: f.base }), /schema measurement-source-config\/1/);
  await assert.rejects(run({ action: 'read_source_config' }, {}), /action must be collect_from_config/);
  assert.throws(() => validateSourceConfig({ ...f.config, source_roots: [] }), /source_roots must contain/);
  assert.throws(() => validateSourceConfig({ ...f.config, price_book: { ...f.config.price_book, source_tool: 'nope' } }), /price_book.source_tool/);
});

test('an all-empty scan is incomplete, never a complete zero result', async t => {
  const f = await fixture(t);
  const result = await collectAndRefresh({ source_roots: [], receipt_roots: [], meters: [], prices: [] });
  assert.equal(result.discovery.complete, false);
  assert.equal(result.coverage.status, 'stale-or-incomplete');
  assert.equal(result.coverage.total_cost, null);
  assert.ok(result.discovery.gaps.some(gap => /no source roots/.test(gap)));
  assert.ok(result.discovery.gaps.some(gap => /no execution receipt roots/.test(gap)));
});


test('computer collection refuses roots outside the task grant and missing grants', async t => {
  const f = await fixture(t);
  await assert.rejects(run({ action: 'collect_from_config', config: f.config, prices: [] }, {}), /granted read folder/);
  await assert.rejects(run({ action: 'collect_from_config', config: f.config, prices: [] }, { grantedFolder: f.source }), /outside the granted read folder/);
});

test('a vanished configured root is reported as incomplete discovery, not a complete empty scan', async t => {
  const f = await fixture(t);
  f.config.source_roots[0].path = path.join(f.base, 'vanished-source');
  const prices = { format: 'provider-price-input/1', source_revision: 'book-7', observed_at: '2026-10-31', prices: [], excluded: [] };
  const result = await run({ action: 'collect_from_config', config: f.config, prices }, { grantedFolder: f.base });
  assert.equal(result.discovery.complete, false);
  assert.equal(result.coverage.status, 'stale-or-incomplete');
  assert.equal(result.coverage.total_cost, null);
  assert.ok(result.discovery.gaps.some(gap => /root unavailable/.test(gap)));
});

test('the keep-measurements-current row declares no records door and its answer holds the collection made from the config in the request', async t => {
  const f = await fixture(t);
  const row = (await import('../what-this-tool-does-and-how-to-run-it.json', { with: { type: 'json' } })).default.records.find(r => r.payload.id === 'tool:keep-measurements-current').payload;
  assert.equal(row.invoke.records, undefined);
  assert.ok(row.input_schema.required.includes('config'));
  assert.deepEqual(row.input_schema.properties.action.enum, ['collect_from_config']);
  const prices = { source_revision: 'book-7', observed_at: '2026-10-31', prices: [{ meter: 'vendor.request_ms', unit: 'ms', provider: 'provider-x', amount: 0.02, currency: 'USD', source_revision: 'rate-1' }] };
  const answer = await run({ action: 'collect_from_config', config: f.config, prices }, { grantedFolder: f.base });
  assert.equal(answer.coverage.rows.find(r => r.operation === 'tool:sample-operation').value, 25);
  assert.ok(answer.forecast.value, 'the forecast to keep is in the answer');
  assert.ok(answer.observations.length > 0, 'the observations to keep are in the answer');
});
