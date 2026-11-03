// tools/decide-agent-actions: every row's sample run exactly as the container runs it (node do-work/run-request.mjs <function>, the
// request on standard input), and the refusals a person's AI gets for a request the tool cannot run.
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

test('the two rows run their own sample and the output holds the words the row says it will', async () => {
  assert.equal(rows.length, 2);
  for (const row of rows) {
    for (const check of row.verify) {
      const { code, last } = await run(row.invoke.argv, check.input);
      assert.equal(code, 0, `${row.id}: ${JSON.stringify(last)}`);
      assert.ok(String(select(select(last, row.result_selector), check.output_selector)).includes(check.contains), row.id);
    }
  }
});

test('every row names its folder, is offline, packs what it imports and keeps its own words generic', () => {
  for (const row of rows) {
    const packed = row.invoke.files.package_files;
    assert.deepEqual(packed.map(item => item.package ?? item.module), ['decide-agent-actions', 'formulas', 'content-identity', '@noble/hashes']);
    assert.deepEqual([row.invoke.internet, row.invoke.workdir, row.maker], [false, '/opt/decide-agent-actions', 'maker:decide-agent-actions']);
    assert.ok(Array.isArray(row.input_schema.required) && row.job.length > 20, row.id);
  }
});

test('a request that is not JSON, an unknown function and a request missing its parts are refused with a sentence', async () => {
  assert.match((await run(argvOf('decideAnAgentAction'), 'not json')).last.error, /JSON/);
  assert.match((await run(argvOf('nothingLikeThis'), {})).last.error, /Unknown request/);
  const refused = await run(argvOf('decideAnAgentAction'), { fields: [] });
  assert.equal(refused.code, 1);
  assert.match(refused.last.error, /action must be an object/);
  assert.match((await run(argvOf('decideAnAgentAction'), { action: {}, fields: [], policy: { rules: [] }, now: 'soon' })).last.error, /now must be an ISO time/);
  assert.match((await run(argvOf('checkAnActionPolicy'), { fields: [], policy: {} })).last.error, /policy must be/);
  assert.match((await run(argvOf('checkAnActionPolicy'), { policy: { rules: [] } })).last.error, /fields must be a list/);
});

test('a grant for the same action allows it, and the answer names the once grant to mark used', async () => {
  const sample = rows[0].verify[0].input;
  const asked = (await run(rows[0].invoke.argv, sample)).last.result;
  const { last } = await run(rows[0].invoke.argv, { ...sample, grants: [{ id: 'g1', identity: asked.identity, scope: 'once' }] });
  assert.deepEqual([last.result.verdict, last.result.decided_by, last.result.grant_used], ['allow', { kind: 'grant', id: 'g1' }, 'g1']);
});
