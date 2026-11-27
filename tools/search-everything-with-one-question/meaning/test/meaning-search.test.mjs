// The Workshop seam of meaning-search on synthetic vector sets: the values handed in are one descriptor record and the
// set's files, and the package's own scripts index and rank them. Nothing here is anyone's data.
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSimilar, findSimilarAcross, findSimilarVector, findWordsSaid, spreadItems } from '../read-data/meaning-search.mjs';
import { applyPlan } from '../do-work/process-scripts/ann-index.mjs';
import { mintCanonicalMultihashOfText } from '../do-work/process-scripts/canonical_multihash.mjs';

const KIND = 'semantic-index-descriptor';

// A 2-D float matrix as .npy bytes (version 1, row order), the format the seam reads.
function npy(rows, type = '<f4') {
  const width = { '<f2': 2, '<f4': 4 }[type];
  let header = `{'descr': '${type}', 'fortran_order': False, 'shape': (${rows.length}, ${rows[0].length}), }`;
  header += ' '.repeat(63 - ((10 + header.length) % 64)) + '\n';
  const data = Buffer.alloc(rows.length * rows[0].length * width);
  rows.flat().forEach((value, at) => {
    if (width === 4) data.writeFloatLE(value, at * 4);
    else data.writeUInt16LE(value === 1 ? 0x3c00 : value === -1 ? 0xbc00 : 0, at * 2);
  });
  const lead = Buffer.alloc(10);
  Buffer.from('\x93NUMPY', 'latin1').copy(lead);
  lead[6] = 1;
  lead.writeUInt16LE(header.length, 8);
  return Buffer.concat([lead, Buffer.from(header, 'latin1'), data]);
}

const lines = items => Buffer.from(items.map(item => JSON.stringify(item)).join('\n') + '\n');

// The values a run is handed: records of one kind, and files read a short span at a time so every read pages.
function handedIn({ descriptors, files, span = 7 }) {
  const calls = [];
  return {
    calls,
    recordsOf(type) { calls.push({ method: 'recordsOf', type }); return descriptors.filter(() => type === KIND).map((value, at) => ({ id: `d:${at}`, type, value })); },
    readSpan(name, offset, length) {
      calls.push({ method: 'read_file', input: { name_or_identity: name, offset, length } });
      const bytes = files[name];
      if (!bytes) throw new Error(`no file ${name}`);
      const piece = bytes.subarray(offset, offset + Math.min(length, span));
      return { byte_length: bytes.length, offset, bytes_returned: piece.length, encoding: 'base64', content: piece.toString('base64') };
    },
  };
}

const descriptor = (vectorSet, extra = {}) => ({
  kind: KIND, index_id: 'synthetic-pictures', model_id: 'synthetic-picture-model', model_version: '1',
  model_endpoint: 'http://127.0.0.1:9', descriptor_revision: mintCanonicalMultihashOfText('synthetic descriptor'),
  model_provenance_ref: 'model:synthetic-picture-model@1', min_score: 0, result_limit: 3,
  ann_params: { hyperplane_count: 2, table_count: 4, seed: 7, candidate_limit: 100 }, vector_set: vectorSet, ...extra,
});

const SET = { items: { file: '/Sets/frames.jsonl' }, vectors: { file: '/Sets/frames.npy' }, points_to: { file: 'clip', start: 't' } };
const ITEMS = [
  { clip: 'zorblax-a.mp4', t: 0 }, { clip: 'zorblax-a.mp4', t: 2 }, { clip: 'zorblax-b.mp4', t: 0 },
  { clip: 'zorblax-b.mp4', t: 2 }, { clip: 'zorblax-c.mp4', t: 4 }, { clip: 'zorblax-c.mp4', t: 6 },
];
const VECTORS = [[1, 0, 0, 0], [0.9, 0.1, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0.7, 0.7, 0, 0], [0, 0, 0, 1]];
const asQuery = vector => Buffer.from(JSON.stringify({ vector })).toString('base64');

test('a query vector finds the closest items of the vector set, with the file and time each points to', async () => {
  const given = handedIn({ descriptors: [descriptor(SET)], files: { '/Sets/frames.jsonl': lines(ITEMS), '/Sets/frames.npy': npy(VECTORS) } });
  const answer = await findSimilarVector({ index_id: 'synthetic-pictures', query_vector_base64: asQuery([1, 0, 0, 0]) }, { given });
  assert.equal(answer.model_id, 'synthetic-picture-model');
  const addresses = answer.result.items.map(item => item.address);
  assert.equal(addresses[0], '/Sets/frames.jsonl#0', 'the identical vector ranks first');
  assert.ok(answer.result.items.length <= 3, 'the descriptor result_limit caps the answer');
  assert.deepEqual(answer.points_to['/Sets/frames.jsonl#0'], { file: 'zorblax-a.mp4', start: 0, end: null, text: null });
  const scores = answer.result.items.map(item => item.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores, 'best first');
  for (const item of answer.result.items) {
    assert.match(item.revision, /^1f:[0-9a-f]{64}$/);
    assert.match(item.payload_hash, /^1f:[0-9a-f]{64}$/);
    assert.equal(item.index_id, 'synthetic-pictures');
  }
  assert.ok(given.calls.filter(call => call.method === 'read_file').length > 2, 'files are read a span at a time');
});

// Model the VM's whole-string ceiling at a small size: the same failure must be
// absent for every vector-bearing plan, not only the final answer. Six synthetic
// items force several production-sized batches without a huge matrix or model.
test('bounded indexing keeps one ANN state and candidate order across plan batches', async () => {
  const maxBytes = JSON.parse(readFileSync(new URL('../read-data/meaning-search.json', import.meta.url), 'utf8')).index_batch_bytes;
  const text = 'zorblax '.repeat(150000);
  const items = ITEMS.map((item, at) => ({ ...item, clip: `synthetic-${at}.mp4`, text }));
  const set = { ...SET, points_to: { ...SET.points_to, text: 'text' } };
  const d = descriptor(set, { result_limit: 6, ann_params: { hyperplane_count: 2, table_count: 4, seed: 7, candidate_limit: 4 } });
  const given = handedIn({ descriptors: [d], files: { '/Sets/frames.jsonl': lines(items), '/Sets/frames.npy': npy(items.map(() => [1, 0, 0, 0])) }, span: 262144 });
  const stringify = JSON.stringify;
  const batches = [];
  JSON.stringify = function(value, ...args) {
    const result = stringify.call(this, value, ...args);
    if (Array.isArray(value?.upserts)) {
      const bytes = Buffer.byteLength(result);
      if (bytes > maxBytes) throw new RangeError('Synthetic whole-plan string limit exceeded');
      batches.push(value.upserts.length);
    }
    return result;
  };
  let answer;
  try {
    answer = await findSimilarVector({ index_id: d.index_id, query_vector_base64: asQuery([1, 0, 0, 0]) }, { given });
  } finally { JSON.stringify = stringify; }
  assert.ok(batches.length > 1, 'the complete plan never crosses one process boundary');
  assert.equal(batches.reduce((sum, count) => sum + count, 0), 6);
  assert.deepEqual(answer.result.items.map(item => [item.address, item.score]), [0, 1, 2, 3].map(at => [`/Sets/frames.jsonl#${at}`, 1]), 'the original candidate limit takes the first four across batch boundaries');
  assert.equal(answer.result.considered, 4);
  assert.equal(answer.result.skipped, 0);
  assert.deepEqual(Object.values(answer.points_to).map(point => point.file), [0, 1, 2, 3].map(at => `synthetic-${at}.mp4`));
});

test('ANN batch application is byte-identical to one ordered plan', () => {
  const work = tempFolder(join(tmpdir(), 'meaning-search-batch-parity-'));
  const script = fileURLToPath(new URL('../do-work/process-scripts/ann-index.mjs', import.meta.url));
  const put = (name, value) => { const path = join(work, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const hash = mintCanonicalMultihashOfText('synthetic mutation');
  const upserts = VECTORS.map((vector, at) => ({ index_id: 'synthetic', content_address: `item:${at}`, canonical_address: `item:${at}`, canonical_revision: hash, canonical_payload_hash: hash, source_snapshot_ref: hash, content_text: '' }));
  const vectors = Object.fromEntries(VECTORS.map((vector, at) => [`item:${at}`, vector]));
  const state = put('empty.json', {});
  const params = put('params.json', { hyperplane_count: 2, table_count: 4, seed: 7, candidate_limit: 4 });
  const plan = put('whole.json', { upserts });
  const vectorFile = put('vectors.json', vectors);
  const batches = put('batches.json', { batches: [0, 2, 4].map(start => ({ plan_json: put(`plan-${start}.json`, { upserts: upserts.slice(start, start + 2) }), vectors_json: put(`vectors-${start}.json`, Object.fromEntries(Object.entries(vectors).slice(start, start + 2))) })) });
  for (const mode of ['apply-plan', 'apply-batches']) {
    const ran = spawnSync(process.execPath, [script, '--mode', mode, '--index-id', 'synthetic', '--state-json', state, '--plan-json', mode === 'apply-plan' ? plan : batches, '--vectors-json', vectorFile, '--params-json', params, '--output-state-json', join(work, `${mode}-state.json`), '--output-facts-json', join(work, `${mode}-facts.json`)], { encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
  }
  for (const output of ['state', 'facts']) assert.deepEqual(readFileSync(join(work, `apply-batches-${output}.json`)), readFileSync(join(work, `apply-plan-${output}.json`)), `${output} must retain the whole-plan bytes and insertion order`);
});

test('ANN mutations reuse private dictionaries and ordered bucket membership without changing caller state', () => {
  const hash = mintCanonicalMultihashOfText('synthetic mutation');
  const nextHash = mintCanonicalMultihashOfText('synthetic next snapshot');
  const params = { hyperplane_count: 2, table_count: 4, seed: 7, candidate_limit: 100 };
  const mutation = (id, snapshot = hash) => ({ index_id: 'synthetic', content_address: id, canonical_address: id, canonical_revision: hash, canonical_payload_hash: hash, source_snapshot_ref: snapshot, content_text: '' });
  const seed = mutation('synthetic:seed');
  const { content_text, ...retraction } = seed;
  const before = applyPlan({}, { upserts: [seed] }, { 'synthetic:seed': [1, 0, 0, 0] }, params, 'synthetic').nextState;
  const snapshot = structuredClone(before);
  const subjects = before.subjects;
  const bucket = [...before.buckets[0].values()][0];
  Object.freeze(before.subjects);
  const upserts = Array.from({ length: 32 }, (_, at) => mutation(`synthetic:new-${at}`));
  const vectors = Object.fromEntries(upserts.map(one => [one.content_address, [1, 0, 0, 0]]));
  const keys = Object.keys;
  const includes = Array.prototype.includes;
  let subjectEnumerations = 0;
  let membershipScans = 0;
  Object.keys = function(value) {
    if (Object.prototype.hasOwnProperty.call(value, 'synthetic:seed')) subjectEnumerations += 1;
    return keys(value);
  };
  Array.prototype.includes = function(value, ...rest) {
    if (typeof value === 'string' && value.startsWith('synthetic:')) membershipScans += 1;
    return includes.call(this, value, ...rest);
  };
  let added;
  let removed;
  let restored;
  try {
    added = applyPlan(before, { upserts }, vectors, params, 'synthetic').nextState;
    removed = applyPlan(added, { retracts: [retraction] }, {}, params, 'synthetic').nextState;
    restored = applyPlan(removed, { upserts: [mutation(seed.content_address, nextHash)] }, { [seed.content_address]: [1, 0, 0, 0] }, params, 'synthetic').nextState;
  } finally {
    Object.keys = keys;
    Array.prototype.includes = includes;
  }
  assert.equal(subjectEnumerations, 0, 'a mutation must not enumerate the growing subject dictionary');
  assert.equal(membershipScans, 0, 'a bucket append must use derived membership instead of scanning its ordered array');
  assert.throws(() => applyPlan(before, { upserts: [mutation('synthetic:valid'), mutation('synthetic:no-vector')] }, { 'synthetic:valid': [1, 0, 0, 0] }, params, 'synthetic'), /non-empty numeric vector/);
  assert.deepEqual(before, snapshot, 'applyPlan must not mutate its caller state, including nested maps and arrays, even when a later mutation fails');
  assert.equal(before.subjects, subjects);
  assert.equal([...before.buckets[0].values()][0], bucket);
  assert.equal(added.subjects[seed.content_address].removed, false, 'a later delete must not change an earlier result');
  assert.equal(removed.subjects[seed.content_address].removed, true, 'a later resurrection must not change the removed result');
  for (const table of restored.buckets) assert.deepEqual([...table.values()][0], [...upserts.map(one => one.content_address), seed.content_address], 'delete then resurrection preserves original ordered-array behavior');
});

test('exact mode scans every stored vector with the existing ranker and no ANN preparation', async () => {
  const items = [{ clip: 'near-first.mp4', t: 0 }, { clip: 'best-later.mp4', t: 0 }];
  const files = { '/Sets/frames.jsonl': lines(items), '/Sets/frames.npy': npy([[0.9, 0.1, 0, 0], [1, 0, 0, 0]]) };
  const d = descriptor(SET, { search_mode: 'exact', result_limit: 2 });
  delete d.ann_params;
  const before = structuredClone(d);
  const query = { index_id: d.index_id, query_vector_base64: asQuery([1, 0, 0, 0]), limit: 1 };
  const stringify = JSON.stringify;
  let planWrites = 0;
  JSON.stringify = function(value, ...args) { if (Array.isArray(value?.upserts)) planWrites += 1; return stringify.call(this, value, ...args); };
  let answer;
  try { answer = await findSimilarVector(query, { given: handedIn({ descriptors: [d], files, span: 4096 }) }); }
  finally { JSON.stringify = stringify; }
  assert.equal(planWrites, 0, 'precomputed exact search must not make an indexing plan');
  assert.equal(answer.result.considered, 2);
  assert.deepEqual(answer.result.items.map(item => [answer.points_to[item.address].file, item.score]), [['best-later.mp4', 1]]);
  assert.deepEqual(d, before, 'exact mode must not modify descriptor settings');
  const floor = await findSimilarVector(query, { given: handedIn({ descriptors: [{ ...d, min_score: 1.01 }], files, span: 4096 }) });
  assert.deepEqual(floor.result.items, [], 'exact search never pads below the floor');
  await assert.rejects(findSimilarVector(query, { given: handedIn({ descriptors: [{ ...d, search_mode: 'invented' }], files }) }), /search_mode must be exact or approximate/);
});

test('half-precision vectors are read as their numbers, and a smaller limit asks for fewer', async () => {
  const halves = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [-1, 0, 0, 0], [0, -1, 0, 0]];
  const given = handedIn({ descriptors: [descriptor(SET)], files: { '/Sets/frames.jsonl': lines(ITEMS), '/Sets/frames.npy': npy(halves, '<f2') } });
  const answer = await findSimilarVector({ index_id: 'synthetic-pictures', query_vector_base64: asQuery([0, 0, 1, 0]), limit: 1 }, { given });
  assert.deepEqual(answer.result.items.map(item => [item.address, item.score]), [['/Sets/frames.jsonl#2', 1]]);
});

test('min_score keeps out what is not close enough, and the package never pads the answer', async () => {
  const given = handedIn({ descriptors: [descriptor(SET, { min_score: 0.95 })], files: { '/Sets/frames.jsonl': lines(ITEMS), '/Sets/frames.npy': npy(VECTORS) } });
  const answer = await findSimilarVector({ index_id: 'synthetic-pictures', query_vector_base64: asQuery([0, 0, 0, 1]) }, { given });
  assert.deepEqual(answer.result.items.map(item => item.address), ['/Sets/frames.jsonl#5']);
});

test('the package refuses an index with no descriptor or two, and the seam refuses a set whose files disagree', async () => {
  const files = { '/Sets/frames.jsonl': lines(ITEMS), '/Sets/frames.npy': npy(VECTORS) };
  const query = { index_id: 'synthetic-pictures', query_vector_base64: asQuery([1, 0, 0, 0]) };
  await assert.rejects(findSimilarVector(query, { given: handedIn({ descriptors: [], files }) }), /exactly one current row/);
  await assert.rejects(findSimilarVector(query, { given: handedIn({ descriptors: [descriptor(SET), descriptor(SET)], files }) }), /exactly one current row/);
  const short = { ...files, '/Sets/frames.jsonl': lines(ITEMS.slice(1)) };
  await assert.rejects(findSimilarVector(query, { given: handedIn({ descriptors: [descriptor(SET)], files: short }) }), /6 vectors and .* 5 items/);
  await assert.rejects(findSimilarVector({ index_id: 'synthetic-pictures' }, { given: handedIn({ descriptors: [], files }) }), /query_vector_base64/);
});

// A stand-in for the descriptor's embedding endpoint: each word list becomes a vector by which synthetic words it holds.
async function standInEmbedder() {
  const words = ['zorblax', 'quindle', 'frumple'];
  const vectorOf = text => words.map(word => (text.toLowerCase().includes(word) ? 1 : 0)).concat([0.01]);
  const asked = [];
  const server = createServer((request, reply) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const sent = JSON.parse(body);
      asked.push({ path: request.url, model: sent.model });
      const answer = request.url === '/api/embed' ? { embeddings: sent.input.map(vectorOf) } : { embedding: vectorOf(sent.prompt) };
      reply.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, asked, close: () => new Promise(done => server.close(done)) };
}

test('a set of spoken lines with no vectors is embedded by the descriptor model, and query words find the line', async () => {
  const embedder = await standInEmbedder();
  try {
    const said = [
      { clip: 'zorblax-a.mp4', t: 1.5, end: 3, text: 'The zorblax is ready.' },
      { clip: 'zorblax-a.mp4', t: 4, end: 6, text: 'Quindle first, then frumple.' },
      { clip: 'zorblax-b.mp4', t: 0, end: 2, text: 'A frumple on the table.' },
    ];
    const set = { items: { file: '/Sets/said.jsonl' }, points_to: { file: 'clip', start: 't', end: 'end', text: 'text' } };
    const given = handedIn({ descriptors: [descriptor(set, { index_id: 'synthetic-said', model_id: 'synthetic-words-model', model_endpoint: embedder.url })], files: { '/Sets/said.jsonl': lines(said) } });
    const answer = await findSimilar({ index_id: 'synthetic-said', query_text: 'a frumple', limit: 1 }, { given });
    const [top] = answer.result.items;
    assert.equal(top.address, '/Sets/said.jsonl#2');
    assert.deepEqual(answer.points_to[top.address], { file: 'zorblax-b.mp4', start: 0, end: 2, text: 'A frumple on the table.' });
    assert.deepEqual(embedder.asked.map(call => call.path), ['/api/embed', '/api/embeddings'], 'the lines in one batch, then the query');
    assert.ok(embedder.asked.every(call => call.model === 'synthetic-words-model'));
  } finally { await embedder.close(); }
});

test('exact mode also ranks embedded text batches with the same query model', async () => {
  const embedder = await standInEmbedder();
  try {
    const said = [{ clip: 'first.mp4', text: 'zorblax' }, { clip: 'answer.mp4', text: 'frumple' }];
    const set = { items: { file: '/Sets/said.jsonl' }, points_to: { file: 'clip', text: 'text' } };
    const d = descriptor(set, { search_mode: 'exact', model_endpoint: embedder.url });
    delete d.ann_params;
    const answer = await findSimilar({ index_id: d.index_id, query_text: 'frumple', limit: 1 }, { given: handedIn({ descriptors: [d], files: { '/Sets/said.jsonl': lines(said) }, span: 4096 }) });
    assert.equal(answer.result.considered, 2);
    assert.equal(answer.points_to[answer.result.items[0].address].file, 'answer.mp4');
    assert.deepEqual(embedder.asked.map(call => call.path), ['/api/embed', '/api/embeddings']);
  } finally { await embedder.close(); }
});

test('the package\'s own fact-row tests pass here', () => {
  const script = fileURLToPath(new URL('../do-work/process-scripts/test_make_embedding_facts.py', import.meta.url));
  const ran = spawnSync('python3', ['-I', '-B', script], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /all tests passed/);
});

test('the rows run the seam\'s exports with no store right: the search hands its records in', () => {
  const all = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const rows = all.filter(row => row.invoke.kind === 'container');
  assert.deepEqual(rows, [], 'search implementations are internal exports, not duplicate public tools');
  assert.deepEqual([findSimilarVector, findSimilar, findSimilarAcross, findWordsSaid].map(fn => fn.name), ['findSimilarVector', 'findSimilar', 'findSimilarAcross', 'findWordsSaid']);
  assert.deepEqual(all.map(row => row.id), ['tool:make-a-picture-vector-set-of-my-videos', 'tool:make-a-vector-set-from-picture-vectors-my-apps-kept']);
  const builder = all.find(row => row.id === 'tool:make-a-picture-vector-set-of-my-videos');
  assert.equal(builder.invoke.kind, 'on-your-computer');
  assert.match(builder.invoke.run, /tools\/search-everything-with-one-question\/meaning\/do-work\/make_picture_vector_set\.py --videos \{input\} --out \{output\}/);
  assert.ok(builder.invoke.needs.some(need => need.startsWith('model: CLIP ViT-B-32')));
  const ownerRows = JSON.parse(readFileSync(new URL('../../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const callers = ownerRows.filter(row => row.id === 'tool:search-everything-with-one-question');
  assert.equal(callers.length, 1, 'one registered search caller owns the four internal exports');
  for (const row of callers) {
    assert.equal(row.invoke.may_reach, undefined);
    assert.equal(row.stored, undefined, 'no declared store rights');
    assert.deepEqual(row.invoke.records, { fd: 3, runs: ['tool:words-as-picture-vector'] }, 'no records rights: the run may only run the picture query encoder');
    assert.ok(!JSON.stringify(row).includes('"records:'), 'no records method');
  }
});

test('a spread keeps one recording from filling the answer: per_file, seconds_apart, and an untimed item counts once', async () => {
  const items = [
    { clip: 'zorblax-a.mp4', t: 0 }, { clip: 'zorblax-a.mp4', t: 2 }, { clip: 'zorblax-a.mp4', t: 9 },
    { clip: 'zorblax-a.mp4', t: 20 }, { clip: 'zorblax-b.mp4', t: 1 }, { clip: 'zorblax-c.jpg' }, { clip: 'zorblax-c.jpg' },
  ];
  const vectors = [[1, 0, 0, 0], [0.99, 0.01, 0, 0], [0.98, 0.02, 0, 0], [0.97, 0.03, 0, 0], [0.5, 0.5, 0, 0], [0.9, 0, 0.1, 0], [0.89, 0, 0.11, 0]];
  const files = { '/Sets/frames.jsonl': lines(items), '/Sets/frames.npy': npy(vectors) };
  const given = () => handedIn({ descriptors: [descriptor(SET, { result_limit: 7 })], files });
  const query = { index_id: 'synthetic-pictures', query_vector_base64: asQuery([1, 0, 0, 0]) };
  const plain = await findSimilarVector({ ...query, limit: 3 }, { given: given() });
  assert.deepEqual(plain.result.items.map(item => item.address.split('#')[1]), ['0', '1', '2'], 'without a spread, three frames of one take');
  const spread = await findSimilarVector({ ...query, limit: 4, spread: { per_file: 2, seconds_apart: 5 } }, { given: given() });
  assert.deepEqual(spread.result.items.map(item => item.address.split('#')[1]), ['0', '2', '5', '4'],
    'a: t 0 and t 9 (t 2 is too near, t 20 is past two); one of the untimed picture; then b');
  assert.deepEqual(spread.result.spread, { per_file: 2, seconds_apart: 5, set_aside: 3 });
  const scores = spread.result.items.map(item => item.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores, 'the package\'s order is kept');
  assert.deepEqual(Object.keys(spread.points_to).sort(), spread.result.items.map(item => item.address).sort());
});

test('spreadItems is pure and stops at the limit', () => {
  const pointsTo = new Map([['x#0', { file: 'a', start: 0 }], ['x#1', { file: 'a', start: 30 }], ['x#2', { file: 'b', start: 0 }]]);
  const items = ['x#0', 'x#1', 'x#2'].map(address => ({ address }));
  assert.deepEqual(spreadItems(items, pointsTo, { per_file: 1 }, 5), { kept: [items[0], items[2]], setAside: 1 });
  assert.deepEqual(spreadItems(items, pointsTo, { per_file: 2, seconds_apart: 10 }, 2), { kept: [items[0], items[1]], setAside: 0 });
});

test('a spread that is not { per_file >= 1, seconds_apart >= 0 } is refused before anything is read', async () => {
  const given = handedIn({ descriptors: [descriptor(SET)], files: {} });
  const query = { index_id: 'synthetic-pictures', query_vector_base64: asQuery([1, 0, 0, 0]) };
  for (const spread of [{}, { per_file: 0 }, { per_file: 1.5 }, { per_file: 1, seconds_apart: -1 }, 'two']) {
    await assert.rejects(findSimilarVector({ ...query, spread }, { given }), /spread must be/);
  }
  await assert.rejects(findSimilarVector({ ...query, spread: { per_file: 1 }, limit: 0 }, { given }), /limit must be/);
  assert.deepEqual(given.calls, [], 'nothing was read');
});

const picturesHelper = fileURLToPath(new URL('./synthetic_picture_set.py', import.meta.url));
const helper = (...argv) => spawnSync('python3', [picturesHelper, ...argv], { encoding: 'utf8' });
const canBuild = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('python3', ['-c', 'import numpy']).status === 0;
const buildSkip = canBuild ? false : 'needs ffmpeg and python3 with numpy';

test('make_picture_vector_set keeps one frame every two seconds with its time, goes on where it stopped, and decodes a proxy when there is one', { skip: buildSkip }, () => {
  const work = tempFolder(join(tmpdir(), 'picture-set-'));
  const videos = join(work, 'card', 'CLIP');
  assert.equal(helper('videos', videos, 'red-take.mp4:red:6', 'blue-take.mp4:blue:4').status, 0);
  assert.equal(helper('videos', join(work, 'card', 'PROXY'), 'blue-take-small.mp4:green:4').status, 0);
  const out = join(work, 'set');
  const proxy = ['--proxy', '{dir}/../PROXY/{stem}-small.mp4'];
  const first = helper('build', videos, out, ...proxy);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout).result.frames, 5);
  const rows = readFileSync(join(out, 'frames.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => [row.video, row.t]), [['blue-take.mp4', 0], ['blue-take.mp4', 2], ['red-take.mp4', 0], ['red-take.mp4', 2], ['red-take.mp4', 4]]);
  assert.equal(rows[0].path, join(videos, 'blue-take.mp4'), 'results name the original');
  assert.equal(rows[0].decoded, join(work, 'card', 'PROXY', 'blue-take-small.mp4'), 'the proxy is what was decoded');
  assert.equal(rows[2].decoded, rows[2].path, 'no proxy, so the original');
  assert.equal(JSON.parse(helper('build', videos, out, ...proxy).stdout).result.added, 0, 'a video already done is not read again');
  assert.equal(helper('videos', videos, 'red-again.mp4:red:2').status, 0);
  assert.equal(JSON.parse(helper('build', videos, out, ...proxy).stdout).result.added, 1, 'only the new video is added');
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'done.json'), 'utf8')), ['blue-take.mp4', 'red-again.mp4', 'red-take.mp4']);
  const made = JSON.parse(readFileSync(join(out, 'vector-set.json'), 'utf8'));
  assert.deepEqual(made.vector_set, { items: { file: join(out, 'frames.jsonl') }, vectors: { file: join(out, 'frames.npy') }, points_to: { file: 'path', start: 't' } });
  assert.equal(made.frames, 6);
});

test('a set the builder made is searched by the seam as it is, and a spread gives each red take once', { skip: buildSkip }, async () => {
  const work = tempFolder(join(tmpdir(), 'picture-set-'));
  assert.equal(helper('videos', join(work, 'v'), 'red-one.mp4:red:6', 'red-two.mp4:red:4', 'blue-one.mp4:blue:4').status, 0);
  assert.equal(helper('build', join(work, 'v'), join(work, 'set')).status, 0);
  const { vector_set: set } = JSON.parse(readFileSync(join(work, 'set', 'vector-set.json'), 'utf8'));
  const files = { [set.items.file]: readFileSync(set.items.file), [set.vectors.file]: readFileSync(set.vectors.file) };
  const given = () => handedIn({ descriptors: [descriptor(set, { result_limit: 7 })], files, span: 4096 });
  const query = { index_id: 'synthetic-pictures', query_vector_base64: asQuery([1, 0, 0]), limit: 3 };
  const plain = await findSimilarVector(query, { given: given() });
  assert.ok(plain.result.items.every(item => plain.points_to[item.address].file.endsWith('.mp4') && item.score > 0.99));
  const spread = await findSimilarVector({ ...query, spread: { per_file: 1 } }, { given: given() });
  assert.deepEqual(spread.result.items.map(item => spread.points_to[item.address].file.split('/').pop()).slice(0, 2).sort(), ['red-one.mp4', 'red-two.mp4']);
  assert.equal(spread.points_to[spread.result.items[2].address].file.split('/').pop(), 'blue-one.mp4', 'the third place goes to another video');
});

// Two sets of one model: the "pictures" set holds timed frames, the "stills" set untimed pictures with a readable name.
const FRAMES_B = { items: { file: '/Sets/b.jsonl' }, vectors: { file: '/Sets/b.npy' }, points_to: { file: 'path', carry: ['name'] } };
const acrossWorld = ({ second = {} } = {}) => handedIn({
  descriptors: [descriptor(SET), descriptor(FRAMES_B, { index_id: 'synthetic-stills', result_limit: 3, ...second })],
  files: {
    '/Sets/frames.jsonl': lines(ITEMS), '/Sets/frames.npy': npy(VECTORS),
    '/Sets/b.jsonl': lines([{ path: 'still-one.jpg', name: 'The first still' }, { path: 'still-two.jpg', name: 'The second still' }]),
    '/Sets/b.npy': npy([[0.95, 0.05, 0, 0], [0, 0, 0, 1]]),
  },
  span: 4096,
});
const across = { index_ids: ['synthetic-pictures', 'synthetic-stills'], query_vector_base64: asQuery([1, 0, 0, 0]) };

test('one query over two indexes is ranked together, best first, and carries the fields the descriptor names', async () => {
  const answer = await findSimilarAcross({ ...across, limit: 4 }, { given: acrossWorld() });
  const order = answer.result.items.map(item => item.address);
  assert.equal(order[0], '/Sets/frames.jsonl#0');
  assert.ok(order.includes('/Sets/b.jsonl#0'), 'an item of the second index ranks among the first');
  const scores = answer.result.items.map(item => item.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores);
  assert.deepEqual(answer.points_to['/Sets/b.jsonl#0'], { file: 'still-one.jpg', start: null, end: null, text: null, name: 'The first still' });
  assert.deepEqual(answer.index_ids, across.index_ids);
  assert.equal(answer.model_id, 'synthetic-picture-model');
});

test('one index with a spread keeps the direct search result before its final limit', async () => {
  const items = [
    { clip: 'cluster.mp4', t: 0 }, { clip: 'cluster.mp4', t: 2 }, { clip: 'cluster.mp4', t: 4 },
    { clip: 'distinct-a.mp4', t: 0 }, { clip: 'distinct-b.mp4', t: 0 }, { clip: 'distinct-c.mp4', t: 0 },
  ];
  const files = { '/Sets/frames.jsonl': lines(items), '/Sets/frames.npy': npy(items.map(() => [1, 0, 0, 0])) };
  const input = { query_vector_base64: asQuery([1, 0, 0, 0]), limit: 3, spread: { per_file: 1, seconds_apart: 10 } };
  for (const resultLimit of [6, 3]) {
    const d = descriptor(SET, { result_limit: resultLimit });
    const world = () => handedIn({ descriptors: [d], files, span: 4096 });
    const direct = await findSimilarVector({ ...input, index_id: d.index_id }, { given: world() });
    const across = await findSimilarAcross({ ...input, index_ids: [d.index_id] }, { given: world() });
    assert.deepEqual(across.result, direct.result, 'across must rank to the existing descriptor limit before spreading, just as direct search does');
    assert.deepEqual(across.points_to, direct.points_to);
    assert.deepEqual(across.result.items.map(item => [across.points_to[item.address].file, item.score]), resultLimit === 6 ? [['cluster.mp4', 1], ['distinct-a.mp4', 1], ['distinct-b.mp4', 1]] : [['cluster.mp4', 1]], 'the descriptor limit stays in force even when it cannot fill the requested spread');
  }
  const plain = await findSimilarAcross({ index_ids: ['synthetic-pictures'], query_vector_base64: input.query_vector_base64, limit: 3 }, { given: handedIn({ descriptors: [descriptor(SET, { result_limit: 6 })], files, span: 4096 }) });
  assert.deepEqual(plain.result.items.map(item => item.address), [0, 1, 2].map(at => `/Sets/frames.jsonl#${at}`), 'without a spread the requested limit still applies to each descriptor');
});

test('exact aggregation spreads the global qualified pool before its final limit', async () => {
  const items = [
    { clip: 'cluster.mp4', t: 0 }, { clip: 'cluster.mp4', t: 2 }, { clip: 'cluster.mp4', t: 4 },
    { clip: 'next-distinct.mp4', t: 0 },
  ];
  const files = { '/Sets/frames.jsonl': lines(items), '/Sets/frames.npy': npy([[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0], [0.8, 0.2, 0, 0]]) };
  const exact = descriptor(SET, { search_mode: 'exact', result_limit: 3 });
  const before = structuredClone(exact);
  const world = d => handedIn({ descriptors: [d], files, span: 4096 });
  const query = { query_vector_base64: asQuery([1, 0, 0, 0]), limit: 2, spread: { per_file: 1, seconds_apart: 10 } };
  const direct = await findSimilarVector({ ...query, index_id: exact.index_id }, { given: world(exact) });
  assert.equal(direct.result.items.length, 1, 'the direct-search result_limit still bounds its result');
  const global = await findSimilarAcross({ ...query, index_ids: [exact.index_id] }, { given: world(exact) });
  assert.deepEqual(global.result.items.map(item => global.points_to[item.address].file), ['cluster.mp4', 'next-distinct.mp4'], 'the result cap is not an exact aggregate candidate-pool cap');
  assert.deepEqual(global.result.items.map(item => item.score), [1, 0.970143]);
  const plain = await findSimilarAcross({ index_ids: [exact.index_id], query_vector_base64: query.query_vector_base64, limit: 4 }, { given: world(exact) });
  assert.equal(plain.result.items.length, 4, 'the explicit aggregate limit applies after global ranking');
  const defaulted = await findSimilarAcross({ index_ids: [exact.index_id], query_vector_base64: query.query_vector_base64 }, { given: world(exact) });
  assert.equal(defaulted.result.items.length, 3, 'the descriptor cap remains the aggregate default when no limit is asked');
  const approximate = await findSimilarAcross({ ...query, index_ids: [exact.index_id] }, { given: world({ ...exact, search_mode: 'approximate' }) });
  assert.equal(approximate.result.items.length, 1, 'approximate aggregation retains its existing descriptor pool semantics');
  assert.deepEqual(exact, before, 'collecting candidates must not change descriptor limits or ANN settings');
});

test('across indexes the spread applies to the merged answer and an untimed picture counts once', async () => {
  const answer = await findSimilarAcross({ ...across, limit: 6, spread: { per_file: 1 } }, { given: acrossWorld() });
  const files = answer.result.items.map(item => answer.points_to[item.address].file);
  assert.equal(new Set(files).size, files.length, 'each file once');
  assert.ok(answer.result.spread.set_aside >= 1);
});

test('indexes of different models are refused, not merged, and so are repeated or missing index ids', async () => {
  await assert.rejects(findSimilarAcross(across, { given: acrossWorld({ second: { model_id: 'another-model' } }) }), /different models/);
  for (const index_ids of [undefined, [], ['synthetic-pictures', 'synthetic-pictures'], ['']]) {
    await assert.rejects(findSimilarAcross({ ...across, index_ids }, { given: acrossWorld() }), /Send index_ids/);
  }
});

test('words said: every word longer than two letters, case ignored, in the order the sets hold them, up to the limit', async () => {
  const said = [
    { clip: 'a.mp4', t: 0, end: 2, text: 'The ZORBLAX is on the table.' }, { clip: 'a.mp4', t: 3, end: 5, text: 'A zorblax, no table.' },
    { clip: 'b.mp4', t: 1, end: 2, text: 'Only a table.' }, { clip: 'b.mp4', t: 4, end: 6, text: 'Table, and a zorblax again' },
  ];
  const set = { items: { file: '/Sets/said.jsonl' }, points_to: { file: 'clip', start: 't', end: 'end', text: 'text' } };
  const given = () => handedIn({ descriptors: [descriptor(set, { index_id: 'synthetic-said' })], files: { '/Sets/said.jsonl': lines(said) } });
  const all = await findWordsSaid({ index_ids: ['synthetic-said'], query_text: 'a Zorblax table' }, { given: given() });
  assert.deepEqual(all.lines.map(line => line.address), ['/Sets/said.jsonl#0', '/Sets/said.jsonl#1', '/Sets/said.jsonl#3']);
  assert.deepEqual(all.lines[0], { address: '/Sets/said.jsonl#0', file: 'a.mp4', start: 0, end: 2, text: 'The ZORBLAX is on the table.' });
  assert.equal((await findWordsSaid({ index_ids: ['synthetic-said'], query_text: 'zorblax', limit: 1 }, { given: given() })).lines.length, 1);
  assert.deepEqual((await findWordsSaid({ index_ids: ['synthetic-said'], query_text: 'it is' }, { given: given() })).lines, [], 'no word longer than two letters matches nothing');
  await assert.rejects(findWordsSaid({ index_ids: ['synthetic-said'] }, { given: given() }), /query_text/);
});

test('words said refuses a set that names no text field', async () => {
  const given = handedIn({ descriptors: [descriptor(SET, { index_id: 'synthetic-pictures' })], files: { '/Sets/frames.jsonl': lines(ITEMS) } });
  await assert.rejects(findWordsSaid({ index_ids: ['synthetic-pictures'], query_text: 'zorblax' }, { given }), /needs vector_set/);
});

const keptHelper = fileURLToPath(new URL('./kept_vectors_check.py', import.meta.url));

test('make_vector_set_from_kept_vectors: a matrix and its ids, and a results store, become vector sets the seam reads', { skip: canBuild ? false : 'needs python3 with numpy' }, () => {
  const ran = spawnSync('python3', ['-I', '-B', keptHelper], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
  assert.match(ran.stdout, /all tests passed/);
});
