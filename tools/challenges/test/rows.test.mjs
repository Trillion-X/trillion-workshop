// tools/challenges: every row's sample run exactly as the container runs it (node do-work/run-request.mjs <function>,
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

test('both rows run their own sample and the output holds the words the row says it will', async () => {
  assert.equal(rows.length, 2);
  for (const row of rows) {
    for (const check of row.verify) {
      const { code, last } = await run(row.invoke.argv, check.input);
      assert.equal(code, 0, `${row.id}: ${JSON.stringify(last)}`);
      assert.ok(String(select(select(last, row.result_selector), check.output_selector)).includes(check.contains), row.id);
    }
  }
});

test('every row names its folder, is offline, and carries no maker name of its own', () => {
  for (const row of rows) {
    assert.deepEqual([row.invoke.files.package_files.package, row.invoke.internet, row.maker], ['challenges', false, 'maker:challenges']);
    assert.ok(Array.isArray(row.input_schema.required) && row.job.length > 20, row.id);
  }
});

test('requests that cannot run are refused with a sentence', async () => {
  assert.match((await run(argvOf('checkChallengeDefinitions'), 'not json')).last.error, /JSON/);
  assert.match((await run(argvOf('nothingLikeThis'), {})).last.error, /Unknown request/);
  assert.match((await run(argvOf('checkChallengeDefinitions'), {})).last.error, /definitions must be a list/);
  const base = { definitions: [], scores: {}, observer_id: 'o', started_at: '2026-01-01T09:00:00Z', status_key: 's' };
  assert.match((await run(argvOf('enrollInChallenges'), { ...base, scores: [] })).last.error, /scores must map/);
  assert.match((await run(argvOf('enrollInChallenges'), { ...base, status_key: '' })).last.error, /status_key must be given/);
  assert.match((await run(argvOf('enrollInChallenges'), { ...base, started_at: 'soon' })).last.error, /started_at must be a date/);
  assert.deepEqual((await run(argvOf('enrollInChallenges'), base)).last.result, { enrollments: [], skipped: [] });
});
