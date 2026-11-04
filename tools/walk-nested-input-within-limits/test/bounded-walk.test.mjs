// tools/walk-nested-input-within-limits/read-data/bounded-walk.mjs (DATA in read-data/bounded-walk.json): the one guard for
// untrusted nested input. The first two tests are Trillion-X/trillion test/bounded-walk.test.mjs, moved unchanged except for
// the import path; the third (list rows) stays with its caller, src/lists.mjs. The last test runs the row's sample as the
// container runs it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { boundedWalk, refusalWords } from '../read-data/bounded-walk.mjs';

test('a walk is iterative: 150000 levels of nesting is refused as too deep without a stack overflow', () => {
  let deep = {};
  for (let level = 0; level < 150_000; level += 1) deep = { next: deep };
  const result = boundedWalk(deep);
  assert.deepEqual([result.ok, result.reason, result.limit], [false, 'too_deep', 100]);
  assert.match(refusalWords(result), /nested more than 100 levels/);
});

test('more nodes than the limit, a cycle, and a visitor refusal each give a typed reason; a fine value walks', () => {
  assert.deepEqual(boundedWalk(Array.from({ length: 11 }, () => 1), { limits: { max_nodes: 10 } }).reason, 'too_many_nodes');
  const loop = { a: [] }; loop.a.push(loop);
  assert.equal(boundedWalk(loop).reason, 'cycle');
  assert.equal(boundedWalk({ a: 1, b: 2 }, { visit: node => (node === 2 ? 'no_twos' : undefined) }).reason, 'no_twos');
  const shared = { x: 1 };
  assert.deepEqual(boundedWalk({ p: shared, q: shared }), { ok: true, nodes: 5 }, 'the same object met twice (not inside itself) is fine');
  assert.deepEqual(boundedWalk({ tree: [{ children: [{ children: [] }] }] }, { children: node => node.children ?? (node.tree ?? []) }).ok, true);
});

test('the row sample runs as the container runs it: a value over the limits is refused in words', () => {
  const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url))).records[0].payload;
  const run = spawnSync('node', ['read-data/bounded-walk.mjs'], { cwd: new URL('..', import.meta.url), input: JSON.stringify(row.verify[0].input), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const { result } = JSON.parse(run.stdout);
  assert.deepEqual([result.ok, result.reason, result.limit], [false, 'too_many_nodes', 3]);
  assert.match(result.said, new RegExp(row.verify[0].contains));
});
