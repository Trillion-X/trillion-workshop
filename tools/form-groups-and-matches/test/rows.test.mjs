// Every row runs as the container runs it: its own argv, the files it packs laid on their folders, its sample on
// standard input and, for a row that reads records, the stand-in door with exactly the row's rights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const descriptors = rows.records.map(record => record.payload);
// Standard input as the engine fills the row's stdin template from a sample run (its input, and a task no page
// started): a whole-source fill, or an object of them.
const filled = (template, input, task = {}) => template?.fill
  ? { input, task }[template.fill.from]
  : Object.fromEntries(Object.entries(template).map(([key, item]) => [key, filled(item, input, task)]));
// "$.a.b[0]" read from an object.
const select = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((at, key) => at?.[key], value);

for (const row of descriptors) {
  test(`${row.id}: its sample holds and its answer has the output's required fields`, async () => {
    for (const sample of row.verify) {
      const run = await runRow(row, filled(row.invoke.stdin, sample.input));
      assert.equal(run.status, 0, run.error);
      const result = select({ result: run.result }, row.result_selector);
      assert.ok(String(select(result, sample.output_selector)).includes(sample.contains), `${row.id}: ${sample.output_selector} holds ${sample.contains}`);
      for (const key of row.output_schema.required ?? []) assert.ok(key in result, `${row.id}: the answer has ${key}`);
    }
  });
}

// The community matchmaker's rows: they reach its records (all but the settings check) and pack tools/content-identity
// with the BLAKE3 module it imports.
const COMMUNITY = /community/;
const REACH_RECORDS = new Set(['tool:read-my-groups', 'tool:advance-a-community-matchmaker', 'tool:answer-in-a-community', 'tool:read-my-community-matches', 'tool:forget-a-person-in-a-community']);

test('every row packs its own files and the records door runner, offers no network, and names its maker', () => {
  for (const row of descriptors) {
    assert.equal(row.invoke.internet, false, row.id);
    const packed = row.invoke.files.package_files.map(spec => spec.package ?? spec.module);
    assert.deepEqual(packed, ['form-groups-and-matches', 'records-door', 'content-identity', '@noble/hashes'], row.id);
    assert.equal(row.maker, 'maker:form-groups-and-matches');
    assert.equal(row.invoke.records !== undefined, REACH_RECORDS.has(row.id) || row.read_only !== true, `${row.id}: which rows reach records`);
  }
});

test('the matchmaker rows reach only the matchmaker\'s own kinds, jobs under its prefix and its one-to-one groups; the reader writes nothing', () => {
  for (const row of descriptors.filter(entry => COMMUNITY.test(entry.id) && entry.invoke.records)) {
    for (const right of row.invoke.records.rights) {
      assert.ok(right.kind.startsWith('match') || (right.kind === 'ai-job' && right.prefix === 'ai-job:match:') || (right.kind === 'group' && right.prefix === 'group:introduction:'), `${row.id}: ${right.kind}`);
      if (right.kind === 'match-community' || row.read_only) assert.ok(!right.operations.includes('records:write'), `${row.id}: ${right.kind} is read only`);
    }
  }
});

test('a refusal comes back as an error that says what to fix', async () => {
  const formMatches = descriptors.find(row => row.id === 'tool:form-matches');
  const run = await runRow(formMatches, { program_id: 'p', cycle: '1', relationship_kind: 'k', candidates: [] });
  assert.notEqual(run.status, 0);
  assert.match(run.error, /factors and scope_fields/);
});
