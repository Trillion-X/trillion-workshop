import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { run } from '../read-data/verify-import.mjs';
import { observationRecord } from '../read-data/ledger.mjs';
const data = JSON.parse(await readFile(new URL('../DATA.json', import.meta.url), 'utf8'));
const sample = data.sample_records.find(row => row.type === 'record:cost-measurement-observation').value;

test('import readback separates exact, absent and changed records without writing', async () => {
  const observations = ['exact', 'missing', 'changed'].map(event_id => ({ ...sample, event_id, scope: 'measured', value: 12 }));
  const rows = observations.map(observationRecord);
  const read = new Map([[rows[0].id, rows[0]], [rows[2].id, { ...rows[2], value: { ...rows[2].value, value: 13 } }]]);
  const result = await run({ observations }, { door: { async *list() { yield* read.values(); } } });
  assert.equal(result.exact, 1);
  assert.equal(result.missing_count, 1);
  assert.equal(result.different_count, 1);
  assert.equal(result.complete, false);
  assert.deepEqual(result.different, [{ id: rows[2].id, fields: ['value'] }]);
});

test('a refused read is an error rather than an absent record', async () => {
  const error = Object.assign(new Error('owner unavailable'), { code: 'selected_owner_unavailable' });
  await assert.rejects(run({ observations: [sample] }, { door: { async *list() { throw error; } } }), value => value === error);
  await assert.rejects(run({}, { door: {} }), /observations are required/);
});
