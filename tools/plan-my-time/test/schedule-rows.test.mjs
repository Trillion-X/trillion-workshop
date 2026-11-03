// tools/plan-my-time: the moved calendar planner's two rows (do-work/schedule-requests.mjs) run their own sample exactly as
// the container runs them (records-door's run-an-export.mjs, the request on standard input), and refuse what they cannot run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const tools = fileURLToPath(new URL('../..', import.meta.url));
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload)
  .filter(row => row.invoke.argv.some(arg => arg.endsWith('schedule-requests.mjs')));
const local = argv => argv.map(arg => arg.replace(/^\/opt\//u, tools));
const run = (argv, input) => new Promise(resolve => {
  const child = promisify(execFile)(argv[0], argv.slice(1), { cwd: tools });
  child.child.stdin.end(JSON.stringify(input));
  child.then(({ stdout }) => resolve({ code: 0, last: JSON.parse(stdout.trim().split('\n').pop()) }), error => resolve({ code: error.code, last: JSON.parse(error.stdout.trim().split('\n').pop()) }));
});
const select = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((at, key) => at?.[key], value);

test('the planner rows run their own sample and the output holds the words the row says it will', async () => {
  assert.equal(rows.length, 2);
  for (const row of rows) {
    for (const check of row.verify) {
      const { code, last } = await run(local(row.invoke.argv), check.input);
      assert.equal(code, 0, `${row.id}: ${JSON.stringify(last)}`);
      assert.ok(String(select(select(last, row.result_selector), check.output_selector)).includes(check.contains), row.id);
    }
  }
});

test('a time zone that is not one, and a timebox without its placement, are refused with a sentence', async () => {
  const [plan, timebox] = rows.map(row => local(row.invoke.argv));
  assert.match((await run(plan, { tasks: [], time_zone: 'Nowhere/Here' })).last.error, /IANA time zone/u);
  assert.match((await run(timebox, { task: { title: 'A task' } })).last.error, /proposal/u);
});
