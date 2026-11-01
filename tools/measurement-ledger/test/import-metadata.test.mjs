import test from 'node:test';
import assert from 'node:assert/strict';
import { importTrafficCases, importStorageRuns } from '../read-data/import-audit.mjs';

test('declared money currency survives metric names with no price keyword', () => {
  const rows = importTrafficCases([{ provider: 'example', storage: 1.35, egress: 2 }], {
    sourceRevision: 'source-1', fieldDefinitions: {
      storage: { unit: 'USD/month', currency: 'USD', metric_kind: 'money_sum' },
      egress: { unit: 'USD/month', currency: 'USD', aggregation: 'money_sum' },
    },
  });
  assert.ok(rows.every(row => row.value.currency === 'USD' && row.value.aggregation === 'money_sum'));
});

test('explicit measurement semantics take priority over metric-name guesses', () => {
  const [row] = importStorageRuns([{ run_id: 'one', metrics: { temperature: 4 } }], {
    dataset: 'fixture', sourceRevision: 'source-1', fieldDefinitions: {
      temperature: { unit: 'degree', currency: 'none', metric_kind: 'gauge', aggregation: 'gauge' },
    },
  });
  assert.equal(row.value.metric_kind, 'gauge');
  assert.equal(row.value.aggregation, 'gauge');
  assert.equal(row.value.unit, 'degree');
});
