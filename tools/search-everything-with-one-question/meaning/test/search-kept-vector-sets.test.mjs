import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { localGiven, searchKeptVectorSets } from '../do-work/search-kept-vector-sets.mjs';

const python = process.env.VECTOR_PYTHON || 'python3';
const fixture = fileURLToPath(new URL('./query-cli-fixture.py', import.meta.url));
const converter = fileURLToPath(new URL('../do-work/make_vector_set_from_kept_vectors.py', import.meta.url));
function execute(args) {
  const ran = spawnSync(python, args, { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  return JSON.parse(ran.stdout);
}

test('the shared search retains float32 source order, timed spread, readable names and spoken-word output', async () => {
  const work = tempFolder(join(tmpdir(), 'kept-vector-cli-'));
  const places = execute([fixture, 'make', work]);
  const output = join(work, 'sets');
  const converted = execute([converter, '--out', output, '--asset-index', places.ASSET_INDEX, '--ssd-index', places.SSD_INDEX,
    '--expansion-results', places.EXPANSION_RESULTS, '--namespace', places.TRILLION_NAMESPACE]);
  const input = { queries: ['blue sky'], vectors: [[1, 0, 0]],
    sets: Object.keys(converted.result.sets).map(index_id => ({ index_id, metadata: join(output, index_id, 'vector-set.json') })),
    transcripts: join(places.SSD_INDEX, 'transcripts.jsonl'), indexes: [places.ASSET_INDEX, places.SSD_INDEX],
    model_id: 'open_clip ViT-B-32', model_version: 'openai', top: 8, per_clip: 2 };
  const answer = await searchKeptVectorSets(input);
  assert.equal(answer.model, 'open_clip ViT-B-32 openai');
  assert.deepEqual(answer.indexes, input.indexes);
  const { seen, said } = answer.results['blue sky'];
  assert.equal(seen.length, 8);
  assert.deepEqual(seen.slice(0, 2).map(hit => hit.path), [join(work, 'z.mp4'), join(work, 'expansion.mp4')]);
  assert.equal(seen[0].name, 'Readable z.mp4');
  assert.equal(seen[0].exists, true);
  assert.equal(seen[1].expansion_id, '12:synthetic');
  assert.equal(seen[1].b2, 'synthetic-b2');
  const firstClose = seen.findIndex(hit => hit.path === join(work, 'close-a.mp4'));
  const secondClose = seen.findIndex(hit => hit.path === join(work, 'close-b.mp4'));
  assert.ok(firstClose < secondClose, 'source dot ordering is retained where cosine would reverse the close candidates');
  assert.deepEqual(seen.filter(hit => hit.path === join(work, 'close-a.mp4')).map(hit => hit.seconds), [0, 15]);
  assert.deepEqual(said, [
    { path: join(work, 'z.mp4'), seconds: 0, end: 1, text: 'blue sky nearby', kind: 'said', name: 'Readable z.mp4', exists: true },
    { path: join(work, 'speech.m4a'), seconds: 3, end: 4, text: 'a blue sky above', kind: 'said', name: 'speech.m4a', exists: false },
  ]);
  const one = await searchKeptVectorSets({ ...input, top: 1, per_clip: 1 });
  assert.equal(one.results['blue sky'].seen.length, 1);
  assert.equal(one.results['blue sky'].said.length, 1);
});

test('local vector-set reads use exact bounded spans and refuse unbounded ones', async () => {
  const given = localGiven([]);
  const expected = readFileSync(fixture).subarray(3, 11);
  const answer = given.readSpan(fixture, 3, 8);
  assert.deepEqual(Buffer.from(answer.content, 'base64'), expected);
  assert.throws(() => given.readSpan(fixture, -1, 8), /Only bounded file reads/);
  assert.throws(() => given.readSpan(fixture, 0, 1.5), /Only bounded file reads/);
});
