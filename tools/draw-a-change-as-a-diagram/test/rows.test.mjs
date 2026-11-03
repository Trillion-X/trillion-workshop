// tools/draw-a-change-as-a-diagram: every row's sample run exactly as the container runs it (node do-work/run-request.mjs
// <function>, the request on standard input), and the refusals for a request the tool cannot run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const folder = new URL('..', import.meta.url).pathname;
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const run = (argv, input) => new Promise(resolve => {
  const child = promisify(execFile)(argv[0], argv.slice(1), { cwd: folder, maxBuffer: 64 * 1024 * 1024 });
  child.child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  child.then(({ stdout }) => resolve({ code: 0, last: JSON.parse(stdout.trim().split('\n').pop()) }), error => resolve({ code: error.code, last: JSON.parse(error.stdout.trim().split('\n').pop()) }));
});
const select = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((at, key) => at?.[key], value);

test('the four rows run their own sample and the output holds the words the row says it will', async () => {
  assert.equal(rows.length, 4);
  for (const row of rows) {
    for (const check of row.verify) {
      const { code, last } = await run(row.invoke.argv, check.input);
      assert.equal(code, 0, `${row.id}: ${JSON.stringify(last)}`);
      assert.ok(String(select(select(last, row.result_selector), check.output_selector)).includes(check.contains), row.id);
    }
  }
});

test('every row packs its own folder, is offline, and says its job in plain words', () => {
  for (const row of rows) {
    assert.deepEqual([row.invoke.files.package_files[0].package, row.invoke.internet, row.maker, row.status], ['draw-a-change-as-a-diagram', false, 'maker:draw-a-change-as-a-diagram', 'active']);
    assert.ok(row.job.length > 20, row.id);
  }
});

test('a request that is not JSON and an unknown function are refused with a sentence', async () => {
  assert.match((await run(['node', 'do-work/run-request.mjs', 'drawDiagram'], 'not json')).last.error, /JSON/);
  assert.match((await run(['node', 'do-work/run-request.mjs', 'nothingLikeThis'], {})).last.error, /Unknown request/);
});
