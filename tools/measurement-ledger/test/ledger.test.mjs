import test from 'node:test';
import assert from 'node:assert/strict';
import { EventConflictError, aggregate, appendOnce, billingRecord, forecastRecord } from '../read-data/ledger.mjs';
import { runRow } from '../../records-door/test/run-row.mjs';
import { importAttemptRows, importUsageEvents, prepareAuditImport } from '../read-data/import-audit.mjs';
import { run as runLedgerTool } from '../do-work/ledger-tool.mjs';
import schema from '../DATA.json' with { type: 'json' };
import rows from '../tool-rows.json' with { type: 'json' };

const base = (changes = {}) => ({ event_id: 'event-1', provider: 'host-a', operation: 'inference', metric: 'duration', metric_kind: 'duration_distribution', aggregation: 'duration_distribution', unit: 'ms', currency: 'none', scenario_id: 'production', source_revision: 'rev-a', run_id: 'run-a', window_start: '2026-10-31T10:00:00-06:00', window_end: '2026-10-31T10:01:00-06:00', observed_at: '2026-10-31T10:00:30-06:00', scope: 'measured', value: 25, ...changes });
const rec = (o) => ({ id: `record:cost-measurement-observation:${encodeURIComponent(o.event_id)}`, type: 'record:cost-measurement-observation', value: { schema: 2, ...o } });

test('default aggregate separates currencies, scenarios, runs, sources, time windows, and units', () => {
  const items = [base(), base({ event_id: 'e2', currency: 'USD' }), base({ event_id: 'e3', scenario_id: 'alternative' }), base({ event_id: 'e4', run_id: 'run-b' }), base({ event_id: 'e5', source_revision: 'rev-b' }), base({ event_id: 'e6', window_start: 'next', window_end: 'next' }), base({ event_id: 'e7', unit: 's' })];
  assert.equal(aggregate(items).length, 7);
});

test('unknown mixed with measured is visibly partial and does not become a complete zero', () => {
  const result = aggregate([base({ metric: 'ops', metric_kind: 'counter_delta', aggregation: 'counter_delta', unit: 'op', value: 4 }), base({ event_id: 'assumed', metric: 'ops', metric_kind: 'counter_delta', aggregation: 'counter_delta', unit: 'op', value: 2, scope: 'assumed' }), base({ event_id: 'missing', metric: 'ops', metric_kind: 'counter_delta', aggregation: 'counter_delta', unit: 'op', value: null, scope: 'unknown' })])[0];
  assert.equal(result.value, 6); assert.equal(result.completeness, 'partial'); assert.equal(result.value_scope, 'partial'); assert.equal(result.unknown_count, 1);
  assert.equal(result.count, 3); assert.equal(result.measured_count, 1); assert.equal(result.assumed_count, 1); assert.equal(result.unknown_count, 1);
  const allUnknown = aggregate([base({ metric: 'unknown', metric_kind: 'counter_delta', aggregation: 'counter_delta', unit: 'op', value: null, scope: 'unknown' })])[0];
  assert.equal(allUnknown.value, null); assert.equal(allUnknown.completeness, 'unknown');
});

test('metric semantics use counter sum, latest gauge, and duration distribution', () => {
  const counter = aggregate([base({ metric: 'n', metric_kind: 'counter_delta', aggregation: 'counter_delta', value: 2 }), base({ event_id: '2', metric: 'n', metric_kind: 'counter_delta', aggregation: 'counter_delta', value: 3 })])[0];
  assert.equal(counter.value, 5);
  const gauge = aggregate([base({ metric: 'cpu', metric_kind: 'gauge', aggregation: 'gauge', value: 10, observed_at: '2026-10-31T10:00:00Z' }), base({ event_id: 'later', metric: 'cpu', metric_kind: 'gauge', aggregation: 'gauge', value: 12, observed_at: '2026-10-31T10:01:00Z' })])[0];
  assert.equal(gauge.value, 12);
  const dist = aggregate([base(), base({ event_id: 'd2', value: 60 })])[0];
  assert.deepEqual(dist.value, { count: 2, min: 25, max: 60, sum: 85 });
});

test('retry and error totals preserve unknown coverage rather than treating missing data as zero', () => {
  const result = aggregate([base({ event_id: 'known', metric: 'ops', metric_kind: 'counter_delta', aggregation: 'counter_delta', unit: 'op', value: 1, retry_count: 0, error_count: 0 }),
    base({ event_id: 'missing', metric: 'ops', metric_kind: 'counter_delta', aggregation: 'counter_delta', unit: 'op', value: 1, retry_count: null, retry_status: 'unknown', error_count: null, error_status: 'unknown' })])[0];
  assert.equal(result.retry_count, 0); assert.equal(result.retry_completeness, 'partial'); assert.equal(result.retry_unknown_count, 1);
  assert.equal(result.error_completeness, 'partial'); assert.equal(result.error_unknown_count, 1);
});

test('correction replaces the prior event in aggregates and ambiguous corrections fail closed', () => {
  const original = base({ event_id: 'original', value: 10 });
  const correction = base({ event_id: 'correction', corrects_event_id: 'original', value: 8 });
  assert.equal(aggregate([original, correction])[0].value.sum, 8);
  assert.throws(() => aggregate([original, correction, base({ event_id: 'correction-2', corrects_event_id: 'original', value: 9 })]), /ambiguous corrections/);
  assert.throws(() => aggregate([base({ corrects_event_id: 'absent' })]), /target missing/);
  assert.throws(() => aggregate([base({ event_id: 'cycle-a', corrects_event_id: 'cycle-b' }), base({ event_id: 'cycle-b', corrects_event_id: 'cycle-a' })]), /cycle detected/);
});

test('incomplete forecasts are retained while a false complete claim is refused', () => {
  const common = { forecast_id: 'forecast-a', version: 1, source_revision: 'rev', created_at: 'now', components: [{ operation: 'native', metric: 'cpu', unit: 'ms', currency: 'USD', scenario_id: 'forecast-case', scope: 'unknown', value: null }] };
  assert.equal(forecastRecord(common).value.completeness, 'incomplete');
  assert.throws(() => forecastRecord({ ...common, completeness: 'complete' }), /cannot claim.*complete/);
});

test('billing records are versioned separately and unknown invoice amounts stay null', () => {
  const common = { provider: 'hosted-vendor', billing_id: 'invoice-2026-10', version: 1, billing_period_start: '2026-10-01', billing_period_end: '2026-10-31', currency: 'USD', unit: 'invoice', source_revision: 'rate-sheet-v1', observed_at: '2026-10-31', scope: 'unknown', amount: null, evidence: 'invoice reference' };
  const record = billingRecord(common);
  assert.equal(record.id, 'record:cost-measurement-billing:invoice-2026-10:v1'); assert.equal(record.value.amount, null);
  assert.throws(() => billingRecord({ ...common, scope: 'measured', amount: null }), /finite/);
});

test('append-once distinguishes exact replay and conflicting content with records-door CAS semantics', async () => {
  const saved = new Map();
  const door = { async readRecord(type, id) { const value = saved.get(id); return value ? { type, value } : null; }, async write(records, { key }) {
    for (const r of records) if (r.expected === null && saved.has(r.id)) { const e = new Error('conflict'); e.code = 'original_command_conflict'; throw e; }
    for (const r of records) saved.set(r.id, r.value);
    return { write_count: records.length, key };
  } };
  assert.equal((await appendOnce(door, [base()], { key: 'append-1' })).inserted, 1);
  assert.equal((await appendOnce(door, [base()], { key: 'append-1' })).replayed, 1);
  await assert.rejects(() => appendOnce(door, [base({ value: 26 })], { key: 'append-2' }), EventConflictError);
  const racing = base({ event_id: 'race' });
  const raced = await Promise.all([appendOnce(door, [racing], { key: 'r1' }), appendOnce(door, [racing], { key: 'r2' })]);
  assert.equal(raced.reduce((sum, x) => sum + x.inserted + x.replayed, 0), 2);
});

test('real shared Workshop row appends, reads exact records, and aggregates via records-door consumer', async () => {
  const row = rows.records.find(r => r.payload.id === 'tool:cost-measurement-ledger').payload;
  const observation = base({ event_id: 'consumer-row-event' });
  const written = await runRow(row, { action: 'append', request_key: 'consumer-row-write', observations: [observation] });
  assert.equal(written.status, 0, JSON.stringify(written)); assert.equal(written.result.inserted, 1);
  assert.equal(written.kept[0].type, 'record:cost-measurement-observation');
  const read = await runRow(row, { action: 'aggregate' }, { records: written.kept });
  assert.equal(read.status, 0); assert.equal(read.result.records_read, 1); assert.equal(read.result.aggregate[0].value.count, 1);
  const billing = await runRow(row, { action: 'save_billing', request_key: 'billing-row-write', billing: { provider: 'vendor', billing_id: 'invoice-1', version: 1, billing_period_start: '2026-10-01', billing_period_end: '2026-10-31', currency: 'USD', unit: 'invoice', source_revision: 'rev', observed_at: '2026-10-31', scope: 'unknown', amount: null } });
  assert.equal(billing.status, 0); assert.equal(billing.result.saved, true); assert.equal(billing.kept[0].type, 'record:cost-measurement-billing');
});

test('shared consumer uses bounded writes, exact replay, and conflicting event refusal on records door', async () => {
  const row = rows.records.find(r => r.payload.id === 'tool:cost-measurement-ledger').payload;
  const observations = Array.from({ length: 130 }, (_, i) => base({ event_id: `bulk-${i}` }));
  const input = { action: 'append', request_key: 'bulk-request', observations };
  const first = await runRow(row, input);
  assert.equal(first.status, 0, JSON.stringify(first)); assert.equal(first.result.inserted, 130);
  assert.equal(first.calls.filter(c => c.method === 'records:write').length, 2);
  const replay = await runRow(row, input, { records: first.kept });
  assert.equal(replay.status, 0); assert.equal(replay.result.replayed, 130); assert.equal(replay.calls.filter(c => c.method === 'records:write').length, 0);
  const conflict = await runRow(row, { ...input, request_key: 'bulk-conflict', observations: [base({ event_id: 'bulk-0', value: 777 })] }, { records: first.kept });
  assert.equal(conflict.status, 1); assert.match(conflict.error, /different content/);
});

test('shared consumer saves incomplete forecast versions once and refuses conflicting version content', async () => {
  const row = rows.records.find(r => r.payload.id === 'tool:cost-measurement-ledger').payload;
  const forecast = { forecast_id: 'capacity-host', version: 1, source_revision: 'revision-a', created_at: '2026-10-31', components: [{ operation: 'native_execution', metric: 'cpu_ms', unit: 'ms', currency: 'USD', scenario_id: 'hosted-capacity', scope: 'unknown', value: null }] };
  const saved = await runRow(row, { action: 'save_forecast', request_key: 'forecast-save-1', forecast });
  assert.equal(saved.status, 0); assert.equal(saved.result.completeness, 'incomplete'); assert.equal(saved.kept[0].type, 'record:cost-measurement-forecast');
  const replay = await runRow(row, { action: 'save_forecast', request_key: 'forecast-replay-1', forecast }, { records: saved.kept });
  assert.equal(replay.status, 0); assert.equal(replay.result.replayed, true); assert.equal(replay.calls.filter(c => c.method === 'records:write').length, 0);
  const conflict = await runRow(row, { action: 'save_forecast', request_key: 'forecast-conflict-1', forecast: { ...forecast, components: [{ operation: 'native_execution', metric: 'cpu_ms', unit: 'ms', currency: 'USD', scenario_id: 'hosted-capacity', scope: 'assumed', value: 5 }] } }, { records: saved.kept });
  assert.equal(conflict.status, 1); assert.match(conflict.error, /different content/);
});

test('account DATA samples validate and prior audit importer preserves 60 runs and 40 separate assumed cases', () => {
  const sample = schema.sample_records[0];
  assert.equal(sample.id, `record:cost-measurement-observation:${encodeURIComponent(sample.value.event_id)}`);
  const makeRuns = prefix => Array.from({ length: 30 }, (_, i) => ({ source_id: `${prefix}-run-${i}`, candidate: prefix, workload: 'fixture', scenario_id: `seed-${i % 2}/fault-${i % 3}`,
    totals: { list: { occurrences: 1, attempts: 4, acked: 3, failed: 0, unsupported: 1, skipped: 0, retries: 2, duplicates: 0, meters: { counts: { scan_visits: 99 } } } } }));
  const cases = Array.from({ length: 40 }, (_, i) => ({ provider: `provider-${i % 5}`, scenario: `scenario-${i % 8}`, currency: 'USD', total_known: 1.25, storage: 1, egress: 0, gets: 0.1, puts: 0.15, fixed_monthly: 0, average_stored_gb: 100, served_gb: 20, put_requests: 1000, get_requests: 4000, unknown: ['unpriced gateway'] }));
  const records = prepareAuditImport({ source_revision: { product: 'rust-rev', surrogate: 'architect-rev', traffic: 'traffic-rev' }, evidence_root: '/audit',
    run_sets: [{ dataset: 'product', runs: makeRuns('product') }, { dataset: 'surrogate', runs: makeRuns('surrogate') }],
    case_sets: [{ dataset: 'traffic', cases }] });
  assert.equal(records.filter(r => r.value.run_id.startsWith('product-run-')).length, 270);
  assert.equal(records.filter(r => r.value.run_id.startsWith('surrogate-run-')).length, 270);
  assert.equal(records.filter(r => r.value.run_id.startsWith('traffic-case-')).length, 440);
  assert.equal(records.find(r => r.value.metric === 'total_known').value.coverage, 'partial');
  assert.equal(records.find(r => r.value.metric === 'total_known').value.scope, 'assumed');
  assert.equal(new Set(records.filter(r => r.value.operation === 'object_traffic_sensitivity').map(r => r.value.scenario_id)).size, 8);
  assert.equal(records.some(r => r.value.metric === 'unknown_cost_components' && r.value.value === null), true);
});

test('privacy-safe inference evidence retains reported token metrics and unknown price as separate rows', () => {
  const [event] = importUsageEvents([{ observation_id: 'snapshot-1', source_stream: 'stream-a.jsonl', observer_source_revision: 'observer-rev', observed_at_local: '2026-10-31T18:00:00-0600',
    invocation: { provider: 'OpenAI Codex', model: 'gpt-6-luna', route: 'Codex subagent' }, usage_unit: 'provider_reported_tokens',
    usage: { input_tokens_total: 100, cached_input_tokens_subset: 30, output_tokens_total: 5, reasoning_output_tokens_subset: 2 },
    simulation_meter_export: { meters: { counts: { inference_turns: 1 } } }, billing: { amount_dollars: null, status: 'not_priced' }, outcome: 'completed', retry_count: 'unknown' }]);
  assert.equal(event.type, 'record:cost-measurement-observation');
  const prepared = importUsageEvents([{ observation_id: 'snapshot-1', source_stream: 'stream-a.jsonl', observer_source_revision: 'observer-rev', observed_at_local: '2026-10-31T18:00:00-0600',
    invocation: { provider: 'OpenAI Codex', model: 'gpt-6-luna', route: 'Codex subagent' }, usage_unit: 'provider_reported_tokens', usage: { input_tokens_total: 100 },
    billing: { amount_dollars: null, status: 'not_priced' }, outcome: 'completed' }]);
  assert.equal(prepared.find(r => r.value.metric === 'marginal_provider_cost').value.scope, 'unknown');
  assert.equal(prepared.find(r => r.value.metric === 'marginal_provider_cost').value.value, null);
  assert.equal(prepared.find(r => r.value.metric === 'input_tokens_total').value.retry_count, null);
  assert.equal(prepared.find(r => r.value.metric === 'input_tokens_total').value.retry_status, 'unknown');
});

test('native attempt import preserves measured wall time and explicitly unknown CPU and host cost', () => {
  const records = importAttemptRows([{ actual_model: 'local-model', outcome: 'success', retries: 0, wall_ms: 10, usage: { input_tokens: 8, output_tokens: 2 } }], {
    provider: 'local endpoint', operation: 'inference', sourceRevision: 'rev', run_id: 'local-evidence',
    fieldDefinitions: { wall_ms: { unit: 'ms', metric_kind: 'duration_distribution', aggregation: 'duration_distribution' }, input_tokens: { unit: 'token' }, output_tokens: { unit: 'token' } },
    unknownMetrics: [{ metric: 'cpu_time', unit: 'ms' }, { metric: 'host_energy_cost', unit: 'USD', currency: 'USD', metric_kind: 'money_sum', aggregation: 'money_sum' }] });
  assert.equal(records.find(r => r.value.metric === 'wall_ms').value.value, 10);
  assert.equal(records.find(r => r.value.metric === 'cpu_time').value.value, null);
  assert.equal(records.find(r => r.value.metric === 'host_energy_cost').value.scope, 'unknown');
  assert.equal(records.find(r => r.value.metric === 'input_tokens').value.retry_count, 0);
  assert.equal(records.find(r => r.value.metric === 'input_tokens').value.retry_status, 'measured');
});

test('workflow resume reads the latest persisted refresh state through the forecast record owner', async () => {
  const current = { forecast_id: 'coverage-new', version: 2, created_at: '2026-10-31T13:00:00Z', refresh_state: { idempotent_key: 'new-pin', source_pin: 'source-2' } };
  const older = { forecast_id: 'coverage-old', version: 9, created_at: '2026-10-31T12:00:00Z', refresh_state: { idempotent_key: 'old-pin' } };
  let query;
  const result = await runLedgerTool({ action: 'read_latest_refresh_state' }, { door: {
    async *list(input) { query = input; yield { type: 'record:cost-measurement-forecast', value: older }; yield { type: 'record:cost-measurement-forecast', value: current }; },
  } });
  assert.equal(query.type, 'record:cost-measurement-forecast');
  assert.deepEqual(result.state, current.refresh_state);
  assert.equal(result.forecast_id, 'coverage-new');
  assert.equal(result.version, 2);
});


test('historical import does not invent physical observation times or units', () => {
  const rows = prepareAuditImport({ run_sets: [{ dataset: 'fixture', source_revision: 'build-1', runs: [{ run_id: 'run-1', totals: { byte_measurement: 128 } }] }] });
  assert.equal(rows[0].value.observed_at, 'unknown-time');
  assert.equal(rows[0].value.unit, 'unknown');
  assert.equal(rows[0].value.evidence_kind, 'executed-simulation');
});
