import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const driver = fileURLToPath(new URL('./run-query-parity.mjs', import.meta.url));

function fixture(settings = {}) {
  const work = tempFolder(join(tmpdir(), 'query-parity-'));
  const owner = join(work, 'workshop', 'tools', 'search-everything-with-one-question', 'meaning', 'read-data');
  mkdirSync(owner, { recursive: true });
  // A stand-in search owner observes the invocation and reads the values it is handed.
  // Whole-file reads of its input fail, so matching span values alone is not enough.
  writeFileSync(join(owner, 'meaning-search.mjs'), `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
export async function findSimilarAcross(input, { given }) {
  const descriptors = [];
  for (const row of given.recordsOf('semantic-index-descriptor')) descriptors.push(row.value);
  const file = descriptors[0].vector_set.items.file;
  const read = fs.readFileSync;
  fs.readFileSync = (path, ...args) => { if (path === file) throw new Error('Whole-file input read is forbidden'); return read(path, ...args); };
  syncBuiltinESMExports();
  const spans = [];
  for (const [offset, length] of [[2, 3], [8, 5], [10, 4]]) {
    const span = given.readSpan(file, offset, length);
    spans.push({ text: Buffer.from(span.content, span.encoding).toString('utf8'), byte_length: span.byte_length });
  }
  return { observed: { input, descriptors, spans }, result: { items: [{ address: 'a' }, { address: 'b' }] }, points_to: { a: { file: 'sample-a.mp4', start: null }, b: { file: 'sample-b.mp4', start: 2 } } };
}
`);
  const input = join(work, 'input.bin');
  writeFileSync(input, '0123456789');
  const sets = join(work, 'sets.json'), queries = join(work, 'queries.json');
  writeFileSync(sets, JSON.stringify({ sets: [{ index_id: 'synthetic', items: input, vectors: input, points_to: { file: 'path' } }], ann: { seed: 7 }, ...settings }));
  writeFileSync(queries, JSON.stringify({ queries: ['made-up query'], vectors: [[1, 2]] }));
  const baseline = join(work, 'baseline.json');
  const run = (seen) => {
    const args = [driver, join(work, 'workshop'), sets, queries];
    if (seen) { writeFileSync(baseline, JSON.stringify({ results: { 'made-up query': { seen } } })); args.push(baseline); }
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { run, input };
}

test('query driver preserves defaults and query vectors while reading bounded spans', () => {
  const { run, input } = fixture();
  const answer = run();
  assert.deepEqual(Object.keys(answer), ['results']);
  const { observed } = answer.results['made-up query'];
  assert.deepEqual(observed.input, { index_ids: ['synthetic'], query_vector_base64: Buffer.from(JSON.stringify({ vector: [1, 2] })).toString('base64'), limit: 8, spread: { per_file: 2, seconds_apart: 10 } });
  assert.equal(observed.descriptors[0].search_mode, 'approximate');
  assert.equal(observed.descriptors[0].result_limit, 300);
  assert.equal(observed.descriptors[0].min_score, -1);
  assert.deepEqual(observed.spans, [{ text: '234', byte_length: 10 }, { text: '89', byte_length: 10 }, { text: '', byte_length: 10 }]);
  assert.equal(readFileSync(input, 'utf8'), '0123456789');
});

test('query driver reads exact settings from DATA and compares strict file/time order', () => {
  const { run } = fixture({ search_mode: 'exact', top: 3, per_file: 1, seconds_apart: 4, result_limit: 7, min_score: 0.4 });
  const seen = [{ path: 'sample-a.mp4', seconds: null }, { path: 'sample-b.mp4', seconds: 2 }];
  const answer = run(seen);
  const { observed } = answer.results['made-up query'];
  assert.equal(observed.descriptors[0].search_mode, 'exact');
  assert.equal(observed.descriptors[0].result_limit, 7);
  assert.equal(observed.descriptors[0].min_score, 0.4);
  assert.equal(observed.input.limit, 3);
  assert.deepEqual(observed.input.spread, { per_file: 1, seconds_apart: 4 });
  assert.deepEqual(answer.comparison['made-up query'], { equal: true, same_set: true, overlap: 2, old: [['sample-a.mp4', null], ['sample-b.mp4', 2]], new: [['sample-a.mp4', null], ['sample-b.mp4', 2]] });
  const reversed = run([...seen].reverse()).comparison['made-up query'];
  assert.equal(reversed.equal, false);
  assert.equal(reversed.same_set, true);
  const changedTime = run([seen[0], { path: 'sample-b.mp4', seconds: 2.000001 }]).comparison['made-up query'];
  assert.equal(changedTime.equal, false);
  assert.equal(changedTime.same_set, false);
  assert.equal(changedTime.overlap, 1);
});
