// Every row runs as the container runs it: its own argv, the files it packs laid on their folders, its sample on
// standard input and, for a row that reads records, the stand-in door with exactly the row's rights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const descriptors = rows.records.map(record => record.payload);
// "$.a.b[0]" read from an object.
const select = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((at, key) => at?.[key], value);

for (const row of descriptors) {
  test(`${row.id}: its sample holds and its answer has the output's required fields`, async () => {
    for (const sample of row.verify) {
      const run = await runRow(row, sample.input);
      assert.equal(run.status, 0, run.error);
      const result = select({ result: run.result }, row.result_selector);
      assert.ok(String(select(result, sample.output_selector)).includes(sample.contains), `${row.id}: ${sample.output_selector} holds ${sample.contains}`);
      for (const key of row.output_schema.required ?? []) assert.ok(key in result, `${row.id}: the answer has ${key}`);
    }
  });
}

test('every row packs its own files and the records door runner, offers no network, and names its maker', () => {
  for (const row of descriptors) {
    assert.equal(row.invoke.internet, false, row.id);
    assert.deepEqual(row.invoke.files.package_files.map(spec => spec.package), ['form-groups-and-matches', 'records-door'], row.id);
    assert.equal(row.maker, 'maker:form-groups-and-matches');
    assert.equal(row.invoke.records === undefined, row.read_only === true && row.id !== 'tool:read-my-groups', `${row.id}: only the group rows reach records`);
  }
});

test('a refusal comes back as an error that says what to fix', async () => {
  const formMatches = descriptors.find(row => row.id === 'tool:form-matches');
  const run = await runRow(formMatches, { program_id: 'p', cycle: '1', relationship_kind: 'k', candidates: [] });
  assert.notEqual(run.status, 0);
  assert.match(run.error, /factors and scope_fields/);
});
