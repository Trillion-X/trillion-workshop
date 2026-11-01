import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { accountComposition, listRecord, overview } from '../read-data/composition.mjs';
import { aggregate } from '../../measurement-ledger/read-data/ledger.mjs';
const ledgerData = JSON.parse(await readFile(new URL('../../measurement-ledger/DATA.json', import.meta.url), 'utf8'));

const data = JSON.parse(await readFile(new URL('../DATA.json', import.meta.url), 'utf8'));
const row = (event_id, fields = {}) => ({
  event_id, provider: 'provider-a', operation: 'invoke', metric: 'calls',
  metric_kind: 'counter_delta', aggregation: 'counter_delta', unit: 'operation', currency: 'none',
  scenario_id: 'scenario-a', source_revision: 'revision-a', run_id: 'run-a',
  window_start: '2026-10-31T00:00:00-06:00', window_end: '2026-10-31T01:00:00-06:00',
  observed_at: '2026-10-31T01:00:00-06:00', scope: 'measured', value: 1,
  retry_count: 0, error_count: 0, ...fields,
});

test('account composition uses ledger-owned IDs and exact record types', () => {
  const records = accountComposition();
  assert.deepEqual(records.filter(r => r.type === 'list').map(r => r.id).sort(), [
    'list:cost-billing-reconciliation', 'list:cost-forecasts', 'list:cost-measurements',
  ]);
  assert.equal(records.filter(r => r.type === 'list-view').length, 7);
  for (const [name, kind] of Object.entries(data.lists)) {
    assert.equal(`record:${kind.row_type}`, data.record_types[name]);
    const schema = ledgerData.list_schemas[name];
    const listRecordValue = listRecord(kind).value;
    assert.equal(listRecordValue.row_type, schema.value.row_type);
    for (const field of schema.value.fields) assert.ok(listRecordValue.fields.some(candidate => candidate.id === field.id));
  }
  const allView = records.find(r => r.id === 'list-view:cost-measurements:all');
  for (const field of ledgerData.list_schemas.observations.value.fields) assert.ok(allView.value.view.columns.order.includes(field.id));
});

test('every saved view column, sort, filter and grouping field exists on its list', () => {
  for (const list of Object.values(data.lists)) {
    const fields = new Set(list.fields.map(f => f.id));
    for (const view of list.views) {
      for (const field of view.columns ?? []) assert.ok(fields.has(field), `${list.id}/${view.id} column ${field}`);
      for (const field of view.group_by ?? []) assert.ok(fields.has(field), `${list.id}/${view.id} grouping ${field}`);
      for (const { field } of view.sort ?? []) assert.ok(fields.has(field), `${list.id}/${view.id} sort ${field}`);
      if (view.filter) assert.ok(fields.has(view.filter.field), `${list.id}/${view.id} filter ${view.filter.field}`);
    }
  }
});

test('granular aggregates never combine different units, currency, scope or source dimensions', () => {
  const observations = [
    row('event-1', { value: 4 }),
    row('event-2', { value: 7, unit: 'ms' }),
    row('event-3', { value: 9, currency: 'USD', unit: 'USD', aggregation: 'money_sum', metric_kind: 'money_sum' }),
    row('event-4', { scope: 'assumed', value: 2 }),
    row('event-5', { scope: 'unknown', value: null }),
  ];
  const result = overview(observations);
  assert.equal(result.groups.length, 5);
  assert.deepEqual([result.measured_rows, result.assumed_rows, result.unknown_rows], [3, 1, 1]);
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.groups.map(g => g.value).sort((a,b) => (a ?? -1) - (b ?? -1)), [null, 2, 4, 7, 9]);
});

test('corrections remain in history but replace their target in rollups', () => {
  const original = row('event-original', { value: 8 });
  const correction = row('event-correction', { value: 5, corrects_event_id: original.event_id });
  const result = overview([original, correction]);
  assert.equal(result.correction_rows, 1);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].value, 5);
  assert.equal(result.groups[0].count, 1);
  assert.equal(aggregate([original, correction])[0].value, 5);
});

test('account list fields retain observation provenance, forecast components and billing semantics', () => {
  const fields = Object.fromEntries(Object.entries(data.lists).map(([key, list]) => [key, new Set(list.fields.map(f => f.id))]));
  for (const name of ['scenario_id', 'source_revision', 'run_id', 'window_start', 'window_end', 'scope', 'value', 'retry_count', 'error_count', 'corrects_event_id']) assert.ok(fields.observations.has(name));
  for (const name of ['forecast_id', 'version', 'completeness', 'component_count']) assert.ok(fields.forecasts.has(name));
  for (const name of ['billing_id', 'version', 'billing_period_start', 'billing_period_end', 'amount', 'currency', 'unit', 'scope', 'observed_at']) assert.ok(fields.billing.has(name));
});

test('saved screen requests are composed from DATA and retain the existing pricing action', () => {
  assert.deepEqual(Object.keys(data.interface.requests), ['read-observations', 'read-forecasts', 'read-billing', 'manage-pricing']);
  const request = data.interface.requests['manage-pricing'];
  assert.equal(request.resource_operation, 'tools:run');
  assert.equal(request.body.tool, 'tool:manage-usage-pricing');
  assert.deepEqual(request.body.input.action, { from: 'action' });
});


test('canonical ledger observations are visible through the actual List reader', async () => {
  const { readListView } = await import('../../read-a-list-view/read-data/list-view.mjs');
  const { observationRecord } = await import('../../measurement-ledger/read-data/ledger.mjs');
  const item = observationRecord(row('list-consumer-observation'));
  const definitions = accountComposition();
  const held = new Map([...definitions, item].map(r => [r.id, r]));
  const door = {
    async read(type, id) { const r = held.get(id); return r?.type === type ? r.value : null; },
    async list(query) { return { records: [...held.values()].filter(r => r.type === query.type), next: null }; },
  };
  const output = await readListView({ list: 'cost-measurements', names: { list_type: 'list', list_record: 'list:{list_id}', row_type: 'record:{row_type}', view_type: 'list-view' } }, door);
  assert.equal(output.rows.length, 1);
  assert.equal(output.rows[0].record_id, item.id);
  assert.equal(output.rows[0].values.event_id, 'list-consumer-observation');
});

test('saved browser aggregation module has no unresolved or Node-only imports', async () => {
  const { execFileSync } = await import('node:child_process');
  const saved = JSON.parse(execFileSync(process.execPath, [new URL('../do-work/prepare-tool-save.mjs', import.meta.url).pathname], { encoding: 'utf8' }));
  const file = saved.files['ledger.mjs'];
  assert.ok(file.includes('export function aggregate'));
  assert.equal(/(?:from|import)\s*['"](?:node:|\.\.)/.test(file), false);
  const mod = await import(`data:text/javascript;base64,${Buffer.from(file).toString('base64')}`);
  assert.equal(mod.aggregate([row('browser-measurement')])[0].value, 1);
});


test('List fields accept scalar forecast projections while the screen retains component arrays', async () => {
  const { forecastRecord } = await import('../../measurement-ledger/read-data/ledger.mjs');
  const record = forecastRecord({ forecast_id: 'fixture', version: 1, source_revision: 'revision', created_at: 'known-time', components: [{ operation: 'op', metric: 'cpu', unit: 'ms', currency: 'none', scenario_id: 's', scope: 'unknown', value: null }] });
  const list = accountComposition().find(r => r.id === 'list:cost-forecasts');
  assert.equal(list.value.fields.some(f => f.id === 'components'), false);
  assert.equal(list.value.fields.find(f => f.id === 'component_count').kind, 'number');
  assert.equal(record.value.component_count, 1);
  assert.equal(Array.isArray(record.value.components), true);
});
