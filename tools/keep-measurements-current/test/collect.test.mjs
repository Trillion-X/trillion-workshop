import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectAndRefresh } from '../read-data/collect.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'coverage-collector-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'src'); const receipts = path.join(dir, 'receipts');
  await mkdir(source); await mkdir(receipts);
  const catalog = path.join(source, 'tool-rows.json');
  const receipt = path.join(receipts, 'run.json');
  const catalogDoc = operations => ({ kind: 'tool-rows', records: operations.map(id => ({ payload: { kind: 'ai-tool-descriptor', id } })) });
  const writeCatalog = ops => writeFile(catalog, JSON.stringify(catalogDoc(ops)));
  const writeReceipt = value => writeFile(receipt, JSON.stringify({ schema: 'execution-observation/1', id: 'reused-receipt-id', operation: 'new-native-call', source: 'native', source_revision: 'claim-1', at: '2026-10-31T12:00:00-06:00', attempt: 1, useful_work: { status: 'succeeded' }, measurements: [{ meter: 'native.wall_ms', unit: 'ms', value }] }));
  await writeCatalog(['tool:known']); await writeReceipt(11);
  const input = { source_roots: [{ id: 'workshop-catalog', path: source }], receipt_roots: [{ id: 'native', path: receipts, source_revision: 'claim-1' }], meters: [{ id: 'native.wall_ms', unit: 'ms', aggregation: 'duration', required_for_all_operations: true }], prices: [{ meter: 'native.wall_ms', provider: 'native', amount: 0.01, source_revision: 'price-1' }] };
  return { input, catalog, receipt, writeCatalog, writeReceipt };
}

test('collector includes new catalog operations without scenario edits and detects source revisions', async t => {
  const f = await fixture(t);
  const first = await collectAndRefresh(f.input);
  await f.writeCatalog(['tool:known', 'tool:just-added']);
  const second = await collectAndRefresh({ ...f.input, prior: first.refresh_state });
  assert.ok(second.coverage.operations.includes('tool:just-added'));
  assert.equal(second.coverage.stale_sources, true);
  assert.equal(second.coverage.rows.find(r => r.operation === 'tool:just-added').status, 'missing-observation');
});

test('DATA adapters collect an unseen provider operation and its native measurements without parser code', async t => {
  const f = await fixture(t);
  const adapters = [{
    id: 'new-provider-format', format: 'json', schema: 'vendor-run/9', records_path: 'work',
    operation_field: 'verb', provider_field: 'engine', time_field: 'finished_at', source_revision_field: 'build_revision',
    metric_prefix: 'vendor.', fields_path: 'counters', unit: 'token',
    useful_work: { checks: [{ source: 'record', path: 'ok', equals: true }] },
  }];
  await writeFile(f.receipt, JSON.stringify({ schema: 'vendor-run/9', work: [{ verb: 'never-seen-operation', build_revision: 'claim-1', engine: 'local-model', finished_at: '2026-10-31T12:00:00-06:00', ok: true, counters: { input: 17 } }] }));
  const result = await collectAndRefresh({
    ...f.input,
    receipt_adapters: adapters,
    meters: [{ id: 'vendor.input', unit: 'token', aggregation: 'sum', required_for_all_operations: true }],
    prices: [{ meter: 'vendor.input', unit: 'token', provider: 'local-model', amount: 0.01, currency: 'USD', source_revision: 'fixture-price' }],
  });
  const row = result.coverage.rows.find(r => r.operation === 'never-seen-operation' && r.meter === 'vendor.input');
  assert.equal(row.provider, 'local-model');
  assert.equal(row.status, 'measured');
  const observation = result.observations.find(o => o.value.metric === 'vendor.input');
  assert.equal(observation.value.scope, 'measured');
  assert.equal(observation.value.value, 17);
});

test('receipt contents and dropped observations invalidate coverage even with a stable receipt ID', async t => {
  const f = await fixture(t);
  const first = await collectAndRefresh(f.input);
  const firstId = first.coverage.next_state.receipt_ids[0];
  await f.writeReceipt(12);
  const changed = await collectAndRefresh({ ...f.input, prior: first.refresh_state });
  assert.equal(changed.coverage.stale_sources, true);
  assert.notEqual(changed.coverage.next_state.observation_pin, first.coverage.next_state.observation_pin);
  assert.equal(changed.coverage.next_state.receipt_ids[0], firstId);
  await writeFile(f.receipt, JSON.stringify({ schema: 'execution-observation/1', id: 'reused-receipt-id', operation: 'new-native-call', source: 'native', source_revision: 'claim-1', at: '2026-10-31T12:00:00-06:00', attempt: 1, useful_work: { status: 'succeeded' }, measurements: [] }));
  const dropped = await collectAndRefresh({ ...f.input, prior: changed.refresh_state });
  assert.equal(dropped.coverage.total_cost, null);
  assert.equal(dropped.coverage.rows.find(r => r.operation === 'new-native-call').status, 'missing-observation');
  await writeFile(f.receipt, JSON.stringify({ schema: 'execution-observation/1', id: 'reused-receipt-id', operation: 'new-native-call', source: 'native', source_revision: 'claim-1', at: '2026-10-31T12:00:00-06:00', attempt: 1, useful_work: { status: 'succeeded' }, measurements: [{ meter: 'new-unpriced-meter', unit: 'ms', value: 10 }] }));
  const unknownMeter = await collectAndRefresh({ ...f.input, prior: dropped.refresh_state });
  assert.equal(unknownMeter.coverage.total_cost, null);
  assert.equal(unknownMeter.coverage.rows.find(r => r.operation === 'new-native-call' && r.meter === 'new-unpriced-meter').status, 'unknown-meter');
});

test('failed attempt plus successful retry keeps the operation partial and records retry/error counts', async t => {
  const f = await fixture(t);
  const doc = { schema: 'execution-observations/1', receipts: [
    { id: 'try-1', operation: 'new-native-call', source: 'native', source_revision: 'claim-1', at: '2026-10-31T12:00:00-06:00', attempt: 1, useful_work: { status: 'failed' }, measurements: [{ meter: 'native.wall_ms', unit: 'ms', value: 11 }] },
    { id: 'try-2', operation: 'new-native-call', source: 'native', source_revision: 'claim-1', at: '2026-10-31T12:00:01-06:00', attempt: 2, useful_work: { status: 'succeeded' }, measurements: [{ meter: 'native.wall_ms', unit: 'ms', value: 20 }] },
  ] };
  await writeFile(f.receipt, JSON.stringify(doc));
  const result = await collectAndRefresh(f.input);
  const row = result.coverage.rows.find(r => r.operation === 'new-native-call');
  assert.equal(row.status, 'partial-retry-or-error');
  assert.equal(row.retries, 1); assert.equal(row.errors, 1); assert.equal(result.coverage.total_cost, null);
});

test('a resumed unchanged collection keeps the same request key and output records', async t => {
  const f = await fixture(t);
  const first = await collectAndRefresh({ ...f.input, measure_self: true, now: '2026-10-31T12:00:00-06:00' });
  const restarted = await collectAndRefresh({ ...f.input, measure_self: true, now: '2026-10-31T12:00:00-06:00', prior: JSON.parse(JSON.stringify(first.refresh_state)) });
  assert.equal(restarted.coverage.idempotent_key, first.coverage.idempotent_key);
  assert.equal(restarted.persistence.unchanged_run, true);
  assert.deepEqual(restarted.observations.map(x => x.id), first.observations.map(x => x.id));
  assert.deepEqual(restarted.observations, first.observations);
  assert.deepEqual(restarted.forecast.value, first.forecast.value);
});

test('fallback observations remain distinct for providers with no sample', async t => {
  const f = await fixture(t);
  await writeFile(f.receipt, JSON.stringify({ schema: 'execution-observations/1', receipts: [
    { id: 'provider-a-run', operation: 'shared-operation', provider: 'provider-a', source: 'native', source_revision: 'claim-1', at: '2026-10-31T12:00:00-06:00', useful_work: { status: 'succeeded' }, measurements: [] },
    { id: 'provider-b-run', operation: 'shared-operation', provider: 'provider-b', source: 'native', source_revision: 'claim-1', at: '2026-10-31T12:00:00-06:00', useful_work: { status: 'succeeded' }, measurements: [] },
  ] }));
  const result = await collectAndRefresh(f.input);
  const fallbacks = result.observations.filter(row => row.value.operation === 'shared-operation' && row.value.metric === 'native.wall_ms');
  assert.deepEqual(fallbacks.map(row => row.value.provider).sort(), ['provider-a', 'provider-b']);
  assert.equal(new Set(fallbacks.map(row => row.id)).size, 2);
});

test('missing receipt time and source revision remain explicitly unknown', async t => {
  const f = await fixture(t);
  await writeFile(f.receipt, JSON.stringify({ schema: 'execution-observation/1', id: 'untimed', operation: 'new-native-call', source: 'native', provider: 'native', useful_work: { status: 'succeeded' }, measurements: [{ meter: 'native.wall_ms', unit: 'ms', value: 12 }] }));
  const result = await collectAndRefresh(f.input);
  const row = result.observations.find(item => item.value.run_id === 'untimed');
  assert.equal(row.value.scope, 'unknown');
  assert.equal(row.value.source_revision, 'unknown');
  assert.notEqual(row.value.source_revision_current, 'unknown');
  assert.equal(row.value.window_start, 'unknown-time');
  assert.equal(row.value.window_end, 'unknown-time');
  assert.equal(row.value.observed_at, 'unknown-time');
  assert.equal(row.value.timing_source, 'file-mtime-only');
  assert.ok(row.value.file_modified_at);
  assert.equal(result.coverage.total_cost, null);
});

test('native replay keeps invocation measures but does not duplicate cached child elapsed work', async t => {
  const f = await fixture(t);
  await writeFile(f.receipt, JSON.stringify({ schema: 'native-execution-observation-v1', attempts: [
    { operation: 'tool-session', source_id: 'native', provider: 'local-native', source_revision: 'claim-1', observed_at: '2026-10-31T12:00:00-06:00', replayed: false, exit_code: 0, tool_exit_code: 0, cli_wall_ms: 129, tool_elapsed_ms: 28, response_bytes: 703 },
    { operation: 'tool-session', source_id: 'native', provider: 'local-native', source_revision: 'claim-1', observed_at: '2026-10-31T12:01:00-06:00', replayed: true, exit_code: 0, tool_exit_code: 0, cli_wall_ms: 43, tool_elapsed_ms: 28, response_bytes: 702 },
  ], negative_control: { one_child_effect_only: true } }));
  const result = await collectAndRefresh({
    ...f.input,
    receipt_adapters: [{ id: 'native-replay-fixture', format: 'json', schema: 'native-execution-observation-v1', records_path: 'attempts', operation_field: 'operation', source_field: 'source_id', provider_field: 'provider', time_field: 'observed_at', source_revision_field: 'source_revision', replayed_field: 'replayed', metric_prefix: 'native.', unit_suffixes: { _ms: 'ms', _bytes: 'byte' }, conditional_exclusions: [{ when: { field: 'replayed', equals: true }, metrics: ['tool_elapsed_ms'] }], useful_work: { checks: [{ source: 'record', path: 'exit_code', equals: 0 }, { source: 'record', path: 'tool_exit_code', equals: 0 }, { source: 'document', path: 'negative_control.one_child_effect_only', equals: true }] } }],
    meters: [
      { id: 'native.cli_wall_ms', unit: 'ms', aggregation: 'duration', required_for_all_operations: true },
      { id: 'native.tool_elapsed_ms', unit: 'ms', aggregation: 'duration', required_for_all_operations: true },
      { id: 'native.response_bytes', unit: 'byte', aggregation: 'sum', required_for_all_operations: true },
    ],
    prices: [{ meter: 'native.tool_elapsed_ms', unit: 'ms', provider: 'local-native', amount: 0.01, currency: 'USD', source_revision: 'price-native' }],
  });
  const elapsed = result.coverage.rows.find(row => row.operation === 'tool-session' && row.meter === 'native.tool_elapsed_ms');
  assert.equal(elapsed.value, 28);
  assert.equal(elapsed.attempts, 1);
  assert.equal(elapsed.replays, 1);
  assert.equal(elapsed.retries, 0);
  const replayElapsed = result.observations.find(row => row.value.operation === 'tool-session' && row.value.metric === 'native.tool_elapsed_ms' && row.value.execution_replayed);
  assert.equal(replayElapsed, undefined);
  const invocationBytes = result.coverage.rows.find(row => row.operation === 'tool-session' && row.meter === 'native.response_bytes');
  assert.equal(invocationBytes.value, 1405);
});

test('root-count and file/byte limits refuse incomplete discovery rather than silently dropping work', async t => {
  const f = await fixture(t);
  await assert.rejects(collectAndRefresh({ ...f.input, limits: { roots: 1 } }), /Root-count limit exceeded/);
  const bounded = await collectAndRefresh({ ...f.input, limits: { files: 1, bytes: 64, entries: 8 } });
  assert.equal(bounded.discovery.complete, false);
  assert.ok(bounded.discovery.gaps.some(gap => /limit reached/.test(gap)));
  assert.equal(bounded.coverage.total_cost, null);
});
