import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshCoverage } from '../read-data/coverage.mjs';

const base = () => ({
  sources: [{ id: 'native-cli', revision: 'r1' }],
  operations: ['tool-session'],
  meters: [{ id: 'wall_ms', unit: 'ms', source: 'native-cli', required_for_all_operations: true }],
  prices: [{ meter: 'wall_ms', unit: 'ms', provider: 'native-cli', amount: 0.01, currency: 'USD', source_revision: 'p1' }],
  receipts: [{ id: 'r1', operation: 'tool-session', source: 'native-cli', provider: 'native-cli', source_revision: 'r1', at: '2026-10-31T00:00:00Z', attempt: 1, useful_work: { status: 'succeeded' }, measurements: [{ meter: 'wall_ms', unit: 'ms', value: 10 }] }],
});

test('discovers a newly observed operation without a feature declaration', () => {
  const x = base();
  x.receipts.push({ ...x.receipts[0], id: 'r2', operation: 'new-tool-operation' });
  const result = refreshCoverage(x);
  assert.deepEqual(result.operations, ['new-tool-operation', 'tool-session']);
  assert.equal(result.rows.find(r => r.operation === 'new-tool-operation').status, 'measured');
});

test('source and price revision changes make prior coverage stale', () => {
  const x = base();
  const prior = refreshCoverage(x).next_state;
  x.sources[0].revision = 'r2';
  x.prices[0].source_revision = 'p2';
  assert.equal(refreshCoverage({ ...x, prior }).status, 'stale-or-incomplete');
});

test('changed receipt contents invalidate prior coverage even when IDs stay the same', () => {
  const x = base();
  const prior = refreshCoverage(x).next_state;
  x.receipts[0].measurements[0].value = 11;
  const changed = refreshCoverage({ ...x, prior });
  assert.equal(changed.stale_sources, true);
  assert.equal(changed.rows[0].value, 11);
});

test('a catalog-only new operation invalidates the prior forecast', () => {
  const x = base();
  const prior = refreshCoverage(x).next_state;
  x.operations.push('newly-added-operation');
  const result = refreshCoverage({ ...x, prior });
  assert.equal(result.stale_sources, true);
  assert.equal(result.rows.find(r => r.operation === 'newly-added-operation').status, 'missing-observation');
  assert.ok(result.rows.find(r => r.operation === 'newly-added-operation').unknowns.includes('unknown'));
});

test('unknown meter, dropped observation and failed useful work stay unknown', () => {
  for (const mutate of [x => { x.receipts[0].measurements[0].meter = 'new-meter'; }, x => { x.receipts[0].measurements = []; }, x => { x.receipts[0].useful_work.status = 'failed'; }]) {
    const x = base(); mutate(x);
    assert.equal(refreshCoverage(x).total_cost, null);
  }
  const x = base();
  const prior = refreshCoverage(x).next_state;
  x.receipts[0].measurements = [];
  const dropped = refreshCoverage({ ...x, prior });
  assert.equal(dropped.stale_sources, true);
  assert.equal(dropped.total_cost, null);
});

test('retry records and process restart are resumable and idempotent', () => {
  const x = base();
  const first = refreshCoverage(x);
  const again = refreshCoverage({ ...x, prior: first.next_state });
  assert.equal(first.idempotent_key, again.idempotent_key);
  assert.equal(again.rows[0].retries, 0);
  x.receipts[0].useful_work = { status: 'failed' };
  x.receipts.push({ ...x.receipts[0], id: 'r2', attempt: 2, useful_work: { status: 'succeeded' } });
  const retry = refreshCoverage({ ...x, prior: first.next_state });
  assert.equal(retry.rows[0].retries, 1);
  assert.equal(retry.rows[0].status, 'partial-retry-or-error');
});

test('a replay without an included physical sample remains unknown instead of becoming zero', () => {
  const x = base();
  x.receipts[0] = { ...x.receipts[0], replayed: true, excluded_measurements: ['wall_ms'], measurements: [] };
  const row = refreshCoverage(x).rows[0];
  assert.equal(row.value, null);
  assert.equal(row.status, 'missing-observation');
  assert.equal(row.attempts, 0);
  assert.equal(row.replays, 1);
});

test('missing price is unknown, never zero', () => {
  const x = base(); x.prices = [];
  const result = refreshCoverage(x);
  assert.equal(result.rows[0].status, 'missing-price');
  assert.equal(result.rows[0].value, 10);
  assert.equal(result.rows[0].cost, null);
  assert.equal(result.total_cost, null);
});

test('provider prices remain separate and a price for another provider is not applied', () => {
  const x = base();
  x.receipts[0].provider = 'provider-a';
  x.receipts.push({ ...x.receipts[0], id: 'provider-b-run', provider: 'provider-b', source: 'native-cli' });
  x.prices = [
    { meter: 'wall_ms', unit: 'ms', provider: 'provider-a', amount: 0.01, currency: 'USD', source_revision: 'price-a1' },
    { meter: 'wall_ms', unit: 'ms', provider: 'provider-b', amount: 0.02, currency: 'EUR', source_revision: 'price-b1' },
  ];
  const result = refreshCoverage(x);
  const a = result.rows.find(r => r.provider === 'provider-a');
  const b = result.rows.find(r => r.provider === 'provider-b');
  assert.equal(a.cost, 0.1); assert.equal(a.currency, 'USD');
  assert.equal(b.cost, 0.2); assert.equal(b.currency, 'EUR');
  x.prices = x.prices.filter(p => p.provider === 'provider-a');
  const missing = refreshCoverage(x).rows.find(r => r.provider === 'provider-b');
  assert.equal(missing.status, 'missing-price'); assert.equal(missing.cost, null);
});

test('an unqualified price cannot price an operation with a known provider', () => {
  const x = base();
  x.prices = [{ meter: 'wall_ms', amount: 0.01, currency: 'USD', source_revision: 'unqualified' }];
  const row = refreshCoverage(x).rows[0];
  assert.equal(row.status, 'missing-price');
  assert.equal(row.cost, null);
});

test('gauge snapshots use the latest sample instead of adding resource levels', () => {
  const x = base();
  x.meters[0] = { ...x.meters[0], aggregation: 'gauge' };
  x.receipts.push({ ...x.receipts[0], id: 'r2', at: '2026-10-31T00:01:00Z', measurements: [{ meter: 'wall_ms', unit: 'ms', value: 12 }] });
  const result = refreshCoverage(x);
  assert.equal(result.rows[0].value, 12);
});

test('gauge ordering compares timestamps as instants across timezones', () => {
  const x = base();
  x.meters[0] = { ...x.meters[0], aggregation: 'gauge' };
  x.receipts[0].at = '2026-10-31T09:30:00-06:00';
  x.receipts.push({ ...x.receipts[0], id: 'r2', at: '2026-10-31T10:00:00Z', measurements: [{ meter: 'wall_ms', unit: 'ms', value: 12 }] });
  assert.equal(refreshCoverage(x).rows[0].value, 10);
});

test('malformed price amounts stay unknown instead of producing NaN or negative cost', () => {
  for (const amount of [undefined, NaN, Infinity, -0.01]) {
    const x = base();
    x.prices[0] = { ...x.prices[0], amount };
    const result = refreshCoverage(x);
    assert.equal(result.total_cost, null);
    assert.equal(result.rows[0].cost, null);
    assert.notEqual(result.rows[0].status, 'measured');
  }
});

test('price units must match the meter before a cost can be measured', () => {
  const x = base();
  x.prices[0].unit = 'second';
  const row = refreshCoverage(x).rows[0];
  assert.equal(row.status, 'invalid-price');
  assert.equal(row.cost, null);
});

test('overflowing counter sums remain unknown instead of returning Infinity', () => {
  const x = base();
  x.receipts[0].measurements[0].value = Number.MAX_VALUE;
  x.receipts.push({ ...x.receipts[0], id: 'r2' });
  const row = refreshCoverage(x).rows[0];
  assert.equal(row.value, null);
  assert.equal(row.status, 'invalid-measurement-total');
  assert.equal(row.cost, null);
});


test('old receipts never price a new source revision and currencies never add together', () => {
  const x = base(); const prior = refreshCoverage(x).next_state;
  x.sources[0].revision = 'new-code';
  const stale = refreshCoverage({ ...x, prior });
  assert.equal(stale.rows[0].status, 'stale-source-observation');
  assert.equal(stale.rows[0].cost, null);
  assert.equal(stale.total_cost, null);
  const y = base(); y.prices[0].currency = 'USD';
  y.meters.push({ id: 'another-unit', unit: 'ms' });
  y.receipts[0].measurements.push({ meter: 'another-unit', unit: 'ms', value: 1 });
  y.prices.push({ meter: 'another-unit', unit: 'ms', provider: 'native-cli', amount: 1, currency: 'EUR', source_revision: 'p2' });
  const first = refreshCoverage(y); const current = refreshCoverage({ ...y, prior: first.next_state });
  assert.equal(current.total_cost, null);
  assert.equal(current.currency, null);
});
