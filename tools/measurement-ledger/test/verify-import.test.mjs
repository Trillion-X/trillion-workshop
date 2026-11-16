import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { run } from '../read-data/verify-import.mjs';
import { observationRecord } from '../read-data/ledger.mjs';
const data = JSON.parse(await readFile(new URL('../DATA.json', import.meta.url), 'utf8'));
const sample = data.sample_records.find(row => row.type === 'record:cost-measurement-observation').value;

test('import readback separates exact, absent and changed records without a door', async () => {
  const observations = ['exact', 'missing', 'changed'].map(event_id => ({ ...sample, event_id, scope: 'measured', value: 12 }));
  const rows = observations.map(observationRecord);
  const records = [rows[0], { ...rows[2], value: { ...rows[2].value, value: 13 } }];
  const result = await run({ observations, records });
  assert.equal(result.exact, 1);
  assert.equal(result.missing_count, 1);
  assert.equal(result.different_count, 1);
  assert.equal(result.complete, false);
  assert.deepEqual(result.different, [{ id: rows[2].id, fields: ['value'] }]);
});

test('observations and records are both required', async () => {
  await assert.rejects(run({ records: [] }), /observations are required/);
  await assert.rejects(run({ observations: [sample] }), /records are required/);
});
