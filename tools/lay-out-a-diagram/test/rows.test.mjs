// tools/lay-out-a-diagram: every row's sample run exactly as the container runs it (node do-work/run-request.mjs <function>, the
// request on standard input), and the refusals a person's AI gets for a request the tool cannot run.
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
const argvOf = fn => ['node', 'do-work/run-request.mjs', fn];
const nodesOf = (...ids) => ids.map(id => ({ id }));

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

test('every row names its folder, is offline, and says its job in plain words', () => {
  for (const row of rows) {
    assert.deepEqual([row.invoke.files.package_files.package, row.invoke.internet, row.maker, row.status], ['lay-out-a-diagram', false, 'maker:lay-out-a-diagram', 'active']);
    assert.ok(row.job.length > 20 && Array.isArray(row.input_schema.required), row.id);
  }
});

test('a request that is not JSON, an unknown function and a request missing its parts are refused with a sentence', async () => {
  assert.match((await run(argvOf('layOutDiagram'), 'not json')).last.error, /JSON/);
  assert.match((await run(argvOf('nothingLikeThis'), {})).last.error, /Unknown request/);
  assert.match((await run(argvOf('layOutDiagram'), {})).last.error, /Send an object with nodes/);
  assert.match((await run(argvOf('layOutDiagram'), { nodes: [], edges: [] })).last.error, /at least one node/);
  assert.match((await run(argvOf('compareTwoDiagrams'), {})).last.error, /before must be an object/);
});

test('an arrow to a box that is not there, a repeated id, a bad direction and a lane that is not listed are refused in words', async () => {
  const refused = async (request, pattern) => {
    const { code, last } = await run(argvOf('layOutDiagram'), request);
    assert.equal(code, 1);
    assert.match(last.error, pattern);
  };
  await refused({ nodes: nodesOf('a'), edges: [{ from: 'a', to: 'ghost' }] }, /names "ghost" in to, which is not the id of a node/);
  await refused({ nodes: nodesOf('a', 'a'), edges: [] }, /two nodes share the id "a"/);
  await refused({ nodes: nodesOf('a', 'b'), edges: [{ id: 'e1', from: 'a', to: 'b' }, { from: 'a', to: 'b' }] }, /two edges share the id "e1"/);
  await refused({ nodes: nodesOf('a'), edges: [], direction: 'up' }, /direction must be "down" or "right"/);
  await refused({ nodes: [{ id: 'a', lane: 'Customer' }, { id: 'b', lane: 'Courier' }], edges: [], lanes: ['Customer'] }, /names the lane "Courier", which is not in lanes \(Customer\)/);
  await refused({ nodes: [{ id: 'a', lane: 'Customer' }, { id: 'b' }], edges: [], lanes: ['Customer'] }, /nodes\[1\] has no lane/);
  await refused({ nodes: [{ id: 'a', width: -3 }], edges: [] }, /width must be a number above 0/);
});

test('a request over the limits is refused with the limit', async () => {
  const refused = async (request, pattern) => assert.match((await run(argvOf('layOutDiagram'), request)).last.error, pattern);
  await refused({ nodes: Array.from({ length: 1001 }, (_, at) => ({ id: `n${at}` })), edges: [] }, /at most 1000 nodes; this has 1001/);
  await refused({ nodes: nodesOf('a', 'b'), edges: Array.from({ length: 5001 }, () => ({ from: 'a', to: 'b', label: 'x' })) }, /at most 5000 edges/);
  await refused({ nodes: [{ id: 'a', label: 'x'.repeat(201) }], edges: [] }, /label is over the limit of 200 characters/);
});

test('three hundred boxes in a long chain with a back arrow are laid out and drawn, and the answer is the same twice', async () => {
  const ids = Array.from({ length: 300 }, (_, at) => `step ${at}`);
  const request = { nodes: nodesOf(...ids), edges: ids.slice(1).map((id, at) => ({ from: ids[at], to: id })).concat([{ from: ids[0], to: ids[200] }, { from: ids[299], to: ids[10] }]) };
  const first = await run(argvOf('layOutDiagram'), request);
  assert.equal(first.code, 0);
  assert.equal(first.last.result.quality.reversed_edges, 1);
  assert.deepEqual((await run(argvOf('layOutDiagram'), request)).last, first.last);
});
