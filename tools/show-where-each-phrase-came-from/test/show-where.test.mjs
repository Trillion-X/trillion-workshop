// tools/show-where-each-phrase-came-from/test/show-where.test.mjs
//
// The do-work function with a fake door: the one run-sql call, its bound piece id, the refusal of a bad input before any call,
// and the answer shape. No database is reached here; the row's own sample on a computer proves the live read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROVENANCE_SQL, inputOf, showWhere } from '../do-work/show-where.mjs';

const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records[0].payload;
const good = { piece: 'example-piece', credential_name: 'my-database-connection' };

// A door that records each call and answers the run-sql result shape: exit_code, result { columns, rows, row_count }.
const fakeRun = (rows, seen) => async (tool, input) => {
  seen.tool = tool;
  seen.input = input;
  return { exit_code: 0, result: { columns: Object.keys(rows[0] ?? {}), rows, row_count: rows.length } };
};

test('the call is one run of the run-sql tool with the piece id bound as $1', async () => {
  const seen = {};
  await showWhere({ input: good, runTool: fakeRun([], seen) });
  assert.equal(seen.tool, 'tool:run-sql-in-my-database');
  assert.equal(seen.input.credential_name, 'my-database-connection');
  assert.equal(seen.input.sql, PROVENANCE_SQL);
  assert.deepEqual(seen.input.params, ['example-piece']);
  assert.match(PROVENANCE_SQL, /FROM public\.piece_provenance WHERE piece_id = \$1/);
});

test('the answer carries the piece id, the columns and the rows', async () => {
  const rows = [{ piece_id: 'example-piece', span: 'slide-1', library_table: 'passages', library_row_id: 'r1', quote: 'a quote', at: '2026-11-01', recorded_at: '2026-11-02' }];
  const answer = await showWhere({ input: good, runTool: fakeRun(rows, {}) });
  assert.equal(answer.piece_id, 'example-piece');
  assert.deepEqual(answer.columns, Object.keys(rows[0]));
  assert.deepEqual(answer.rows, rows);
  assert.equal(answer.row_count, 1);
});

test('a failed run is refused with the tool\'s own error', async () => {
  const failed = async () => ({ exit_code: 1, error: 'relation does not exist' });
  await assert.rejects(showWhere({ input: good, runTool: failed }), /relation does not exist/);
});

test('a piece id that is not a name, or a missing held name, is refused before any call', async () => {
  let called = false;
  const runTool = async () => { called = true; };
  const bad = [{ piece: '', credential_name: 'x' }, { piece: 'a b', credential_name: 'x' }, { piece: "x' OR 1=1 --", credential_name: 'x' }, { piece: 'p', credential_name: 'Bad Name' }, { piece: 7, credential_name: 'x' }, null];
  for (const input of bad) await assert.rejects(showWhere({ input, runTool }));
  assert.equal(called, false);
});

test('inputOf answers the two names it checked', () => {
  assert.deepEqual(inputOf(good), good);
});

test('the row is a computer tool that names its own do-work and the door client, and holds no connection', () => {
  assert.equal(row.id, 'tool:show-where-each-phrase-came-from');
  assert.equal(row.invoke.kind, 'computer');
  assert.deepEqual(row.input_schema.required, ['piece', 'credential_name']);
  assert.equal(row.invoke.credential_mounts, undefined);
  assert.equal(row.invoke.packages, undefined);
});
