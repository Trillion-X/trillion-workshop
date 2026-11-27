// Every row runs as the container runs it (test-helpers/run-a-row.mjs): its own run, the files it packs laid at their
// places, its standard input filled from its own stdin template with its sample (and a task no page started) and, for
// a row that reads records, the stand-in door with exactly the row's rights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rightsOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };

const descriptors = rows.records.map(record => record.payload);
// "$.a.b[0]" read from an object.
const select = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((at, key) => at?.[key], value);

for (const row of descriptors) {
  test(`${row.id}: its sample holds and its answer has the output's required fields`, async () => {
    for (const sample of row.verify) {
      const run = await answerOf(row, sample.input);
      assert.equal(run.status, 0, run.error);
      const result = select({ result: run.result }, row.result_selector);
      assert.ok(String(select(result, sample.output_selector)).includes(sample.contains), `${row.id}: ${sample.output_selector} holds ${sample.contains}`);
      for (const key of row.output_schema.required ?? []) assert.ok(key in result, `${row.id}: the answer has ${key}`);
    }
  });
}

// The community matchmaker's rows and the group rows take their records as input and reach no store. Every row packs
// tools/content-identity with the BLAKE3 module it imports.
const COMMUNITY = /community/;

test('every row packs its own files and the records door runner, offers no network, and names its maker', () => {
  for (const row of descriptors) {
    assert.equal(row.invoke.may_reach, undefined, row.id);
    const packed = row.invoke.files.package_files.map(spec => spec.package ?? spec.module ?? spec.packages?.[0]?.replace(/^node_modules\//, ""));
    assert.deepEqual(packed, ['form-groups-and-matches', 'records-door', 'content-identity', '@noble/hashes', 'browse-and-upload-my-files'], row.id);
    assert.equal(row.maker, 'maker:form-groups-and-matches');
    assert.deepEqual(rightsOf(row), [], `${row.id}: no row declares stored rights`);
  }
});

test('the community matchmaker rows declare no records door: they read and keep no records and answer `write` for the caller', () => {
  const community = descriptors.filter(entry => COMMUNITY.test(entry.id));
  assert.ok(community.length >= 5);
  for (const row of community) assert.equal(row.invoke.records, undefined, row.id);
  for (const row of community.filter(entry => entry.input_schema.properties.records)) assert.ok(row.output_schema.properties.write, row.id);
});

test('a refusal comes back as an error that says what to fix', async () => {
  const formMatches = descriptors.find(row => row.id === 'tool:form-matches');
  const run = await answerOf(formMatches, { program_id: 'p', cycle: '1', relationship_kind: 'k', candidates: [] });
  assert.notEqual(run.status, 0);
  assert.match(run.error, /factors and scope_fields/);
});
