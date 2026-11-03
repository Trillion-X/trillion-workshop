// tools/field-values: every row's sample run exactly as the container runs it (node do-work/run-request.mjs <function>,
// the request on standard input), and the refusals a person's AI gets for a request the tool cannot run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const folder = new URL('..', import.meta.url).pathname;
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const run = (argv, input) => new Promise(resolve => {
  const child = promisify(execFile)(argv[0], argv.slice(1), { cwd: folder });
  child.child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  child.then(({ stdout }) => resolve({ code: 0, last: JSON.parse(stdout.trim().split('\n').pop()) }), error => resolve({ code: error.code, last: JSON.parse(error.stdout.trim().split('\n').pop()) }));
});
const select = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((at, key) => at?.[key], value);
const argvOf = fn => ['node', 'do-work/run-request.mjs', fn];

test('the three rows run their own sample and the output holds the words the row says it will', async () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:set-fields-by-rules', 'tool:settle-field-values', 'tool:plan-a-column-fill']);
  for (const row of rows) {
    for (const check of row.verify) {
      const { code, last } = await run(row.invoke.argv, check.input);
      assert.equal(code, 0, `${row.id}: ${JSON.stringify(last)}`);
      assert.ok(String(select(select(last, row.result_selector), check.output_selector)).includes(check.contains), row.id);
    }
  }
});

test('every row packs this folder, the formulas it matches rules with and the identity owner, and is offline', () => {
  for (const row of rows) {
    assert.deepEqual(row.invoke.files.package_files.map(spec => spec.package ?? spec.module), ['field-values', 'formulas', 'content-identity', '@noble/hashes'], row.id);
    assert.deepEqual([row.invoke.internet, row.maker, row.invoke.workdir], [false, 'maker:field-values', '/opt/field-values'], row.id);
    assert.ok(row.job.length > 40 && row.input_schema.required.length > 0, row.id);
  }
});

test('a request that is not JSON, an unknown function and a request missing its parts are refused with a sentence', async () => {
  assert.match((await run(argvOf('setFields'), 'not json')).last.error, /JSON/);
  assert.match((await run(argvOf('nothingLikeThis'), {})).last.error, /Unknown request/);
  assert.match((await run(argvOf('setFields'), { fields: [] })).last.error, /records must be a list/);
  assert.match((await run(argvOf('settleValues'), { offers: 'all' })).last.error, /offers must be a list/);
  assert.match((await run(argvOf('planColumnFill'), { records: [], id_path: ['id'], field: { id: 'x' } })).last.error, /sources must be a list/);
});
