// The Workshop seam of meaning-search on synthetic vector sets: a stand-in door holds one descriptor record and the
// set's files, and the package's own scripts index and rank them. Nothing here is anyone's data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSimilar, findSimilarAcross, findSimilarVector, findWordsSaid, spreadItems } from '../read-data/meaning-search.mjs';
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

// The door a run is handed: records of one kind, and files read a short span at a time so every read pages.
function standInDoor({ descriptors, files, span = 7 }) {
  const calls = [];
  return {
    calls,
    async *list({ type }) { calls.push({ method: 'records:list', type }); yield* descriptors.filter(() => type === KIND).map((value, at) => ({ id: `d:${at}`, type, value })); },
    async files(method, input) {
      calls.push({ method, input });
      const bytes = files[input.name_or_identity];
      if (method !== 'read_file' || !bytes) throw new Error(`no ${method} for ${input.name_or_identity}`);
      const piece = bytes.subarray(input.offset, input.offset + Math.min(input.length, span));
      return { byte_length: bytes.length, offset: input.offset, bytes_returned: piece.length, encoding: 'base64', content: piece.toString('base64') };
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
  const door = standInDoor({ descriptors: [descriptor(SET)], files: { '/Sets/frames.jsonl': lines(ITEMS), '/Sets/frames.npy': npy(VECTORS) } });
  const answer = await findSimilarVector({ index_id: 'synthetic-pictures', query_vector_base64: asQuery([1, 0, 0, 0]) }, { door });
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
  assert.ok(door.calls.filter(call => call.method === 'read_file').length > 2, 'files are read a span at a time');
});

test('half-precision vectors are read as their numbers, and a smaller limit asks for fewer', async () => {
  const halves = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [-1, 0, 0, 0], [0, -1, 0, 0]];
  const door = standInDoor({ descriptors: [descriptor(SET)], files: { '/Sets/frames.jsonl': lines(ITEMS), '/Sets/frames.npy': npy(halves, '<f2') } });
  const answer = await findSimilarVector({ index_id: 'synthetic-pictures', query_vector_base64: asQuery([0, 0, 1, 0]), limit: 1 }, { door });
  assert.deepEqual(answer.result.items.map(item => [item.address, item.score]), [['/Sets/frames.jsonl#2', 1]]);
});

test('min_score keeps out what is not close enough, and the package never pads the answer', async () => {
  const door = standInDoor({ descriptors: [descriptor(SET, { min_score: 0.95 })], files: { '/Sets/frames.jsonl': lines(ITEMS), '/Sets/frames.npy': npy(VECTORS) } });
  const answer = await findSimilarVector({ index_id: 'synthetic-pictures', query_vector_base64: asQuery([0, 0, 0, 1]) }, { door });
  assert.deepEqual(answer.result.items.map(item => item.address), ['/Sets/frames.jsonl#5']);
});

test('the package refuses an index with no descriptor or two, and the seam refuses a set whose files disagree', async () => {
  const files = { '/Sets/frames.jsonl': lines(ITEMS), '/Sets/frames.npy': npy(VECTORS) };
  const query = { index_id: 'synthetic-pictures', query_vector_base64: asQuery([1, 0, 0, 0]) };
  await assert.rejects(findSimilarVector(query, { door: standInDoor({ descriptors: [], files }) }), /exactly one current row/);
  await assert.rejects(findSimilarVector(query, { door: standInDoor({ descriptors: [descriptor(SET), descriptor(SET)], files }) }), /exactly one current row/);
  const short = { ...files, '/Sets/frames.jsonl': lines(ITEMS.slice(1)) };
  await assert.rejects(findSimilarVector(query, { door: standInDoor({ descriptors: [descriptor(SET)], files: short }) }), /6 vectors and .* 5 items/);
  await assert.rejects(findSimilarVector({ index_id: 'synthetic-pictures' }, { door: standInDoor({ descriptors: [], files }) }), /query_vector_base64/);
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
    const door = standInDoor({ descriptors: [descriptor(set, { index_id: 'synthetic-said', model_id: 'synthetic-words-model', model_endpoint: embedder.url })], files: { '/Sets/said.jsonl': lines(said) } });
    const answer = await findSimilar({ index_id: 'synthetic-said', query_text: 'a frumple', limit: 1 }, { door });
    const [top] = answer.result.items;
    assert.equal(top.address, '/Sets/said.jsonl#2');
    assert.deepEqual(answer.points_to[top.address], { file: 'zorblax-b.mp4', start: 0, end: 2, text: 'A frumple on the table.' });
    assert.deepEqual(embedder.asked.map(call => call.path), ['/api/embed', '/api/embeddings'], 'the lines in one batch, then the query');
    assert.ok(embedder.asked.every(call => call.model === 'synthetic-words-model'));
  } finally { await embedder.close(); }
});

test('the package\'s own fact-row tests pass here', () => {
  const script = fileURLToPath(new URL('../do-work/process-scripts/test_make_embedding_facts.py', import.meta.url));
  const ran = spawnSync('python3', ['-I', '-B', script], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /all tests passed/);
});

test('the rows run the seam\'s exports through records-door with read-only rights', () => {
  const all = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const rows = all.filter(row => row.invoke.kind === 'container');
  assert.deepEqual(rows.map(row => row.invoke.argv.at(-1)), ['findSimilarVector', 'findSimilar', 'findSimilarAcross', 'findWordsSaid']);
  const builder = all.find(row => row.id === 'tool:make-a-picture-vector-set-of-my-videos');
  assert.equal(builder.invoke.kind, 'on-your-computer');
  assert.match(builder.invoke.run, /tools\/meaning-search\/do-work\/make_picture_vector_set\.py --videos \{input\} --out \{output\}/);
  assert.ok(builder.invoke.needs.some(need => need.startsWith('model: CLIP ViT-B-32')));
  for (const row of rows) {
    assert.equal(row.invoke.internet, false);
    for (const right of row.invoke.records.rights) assert.ok(right.operations.every(operation => ['records:list', 'read_file'].includes(operation)));
  }
});

test('a spread keeps one recording from filling the answer: per_file, seconds_apart, and an untimed item counts once', async () => {
  const items = [
    { clip: 'zorblax-a.mp4', t: 0 }, { clip: 'zorblax-a.mp4', t: 2 }, { clip: 'zorblax-a.mp4', t: 9 },
    { clip: 'zorblax-a.mp4', t: 20 }, { clip: 'zorblax-b.mp4', t: 1 }, { clip: 'zorblax-c.jpg' }, { clip: 'zorblax-c.jpg' },
  ];
  const vectors = [[1, 0, 0, 0], [0.99, 0.01, 0, 0], [0.98, 0.02, 0, 0], [0.97, 0.03, 0, 0], [0.5, 0.5, 0, 0], [0.9, 0, 0.1, 0], [0.89, 0, 0.11, 0]];
  const files = { '/Sets/frames.jsonl': lines(items), '/Sets/frames.npy': npy(vectors) };
  const door = () => standInDoor({ descriptors: [descriptor(SET, { result_limit: 7 })], files });
  const query = { index_id: 'synthetic-pictures', query_vector_base64: asQuery([1, 0, 0, 0]) };
  const plain = await findSimilarVector({ ...query, limit: 3 }, { door: door() });
  assert.deepEqual(plain.result.items.map(item => item.address.split('#')[1]), ['0', '1', '2'], 'without a spread, three frames of one take');
  const spread = await findSimilarVector({ ...query, limit: 4, spread: { per_file: 2, seconds_apart: 5 } }, { door: door() });
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
  const door = standInDoor({ descriptors: [descriptor(SET)], files: {} });
  const query = { index_id: 'synthetic-pictures', query_vector_base64: asQuery([1, 0, 0, 0]) };
  for (const spread of [{}, { per_file: 0 }, { per_file: 1.5 }, { per_file: 1, seconds_apart: -1 }, 'two']) {
    await assert.rejects(findSimilarVector({ ...query, spread }, { door }), /spread must be/);
  }
  await assert.rejects(findSimilarVector({ ...query, spread: { per_file: 1 }, limit: 0 }, { door }), /limit must be/);
  assert.deepEqual(door.calls, [], 'nothing was read');
});

const picturesHelper = fileURLToPath(new URL('./synthetic_picture_set.py', import.meta.url));
const helper = (...argv) => spawnSync('python3', [picturesHelper, ...argv], { encoding: 'utf8' });
const canBuild = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('python3', ['-c', 'import numpy']).status === 0;
const buildSkip = canBuild ? false : 'needs ffmpeg and python3 with numpy';

test('make_picture_vector_set keeps one frame every two seconds with its time, goes on where it stopped, and decodes a proxy when there is one', { skip: buildSkip }, () => {
  const work = mkdtempSync(join(tmpdir(), 'picture-set-'));
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
  const work = mkdtempSync(join(tmpdir(), 'picture-set-'));
  assert.equal(helper('videos', join(work, 'v'), 'red-one.mp4:red:6', 'red-two.mp4:red:4', 'blue-one.mp4:blue:4').status, 0);
  assert.equal(helper('build', join(work, 'v'), join(work, 'set')).status, 0);
  const { vector_set: set } = JSON.parse(readFileSync(join(work, 'set', 'vector-set.json'), 'utf8'));
  const files = { [set.items.file]: readFileSync(set.items.file), [set.vectors.file]: readFileSync(set.vectors.file) };
  const door = () => standInDoor({ descriptors: [descriptor(set, { result_limit: 7 })], files, span: 4096 });
  const query = { index_id: 'synthetic-pictures', query_vector_base64: asQuery([1, 0, 0]), limit: 3 };
  const plain = await findSimilarVector(query, { door: door() });
  assert.ok(plain.result.items.every(item => plain.points_to[item.address].file.endsWith('.mp4') && item.score > 0.99));
  const spread = await findSimilarVector({ ...query, spread: { per_file: 1 } }, { door: door() });
  assert.deepEqual(spread.result.items.map(item => spread.points_to[item.address].file.split('/').pop()).slice(0, 2).sort(), ['red-one.mp4', 'red-two.mp4']);
  assert.equal(spread.points_to[spread.result.items[2].address].file.split('/').pop(), 'blue-one.mp4', 'the third place goes to another video');
});

// Two sets of one model: the "pictures" set holds timed frames, the "stills" set untimed pictures with a readable name.
const FRAMES_B = { items: { file: '/Sets/b.jsonl' }, vectors: { file: '/Sets/b.npy' }, points_to: { file: 'path', carry: ['name'] } };
const acrossWorld = ({ second = {} } = {}) => standInDoor({
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
  const answer = await findSimilarAcross({ ...across, limit: 4 }, { door: acrossWorld() });
  const order = answer.result.items.map(item => item.address);
  assert.equal(order[0], '/Sets/frames.jsonl#0');
  assert.ok(order.includes('/Sets/b.jsonl#0'), 'an item of the second index ranks among the first');
  const scores = answer.result.items.map(item => item.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores);
  assert.deepEqual(answer.points_to['/Sets/b.jsonl#0'], { file: 'still-one.jpg', start: null, end: null, text: null, name: 'The first still' });
  assert.deepEqual(answer.index_ids, across.index_ids);
  assert.equal(answer.model_id, 'synthetic-picture-model');
});

test('across indexes the spread applies to the merged answer and an untimed picture counts once', async () => {
  const answer = await findSimilarAcross({ ...across, limit: 6, spread: { per_file: 1 } }, { door: acrossWorld() });
  const files = answer.result.items.map(item => answer.points_to[item.address].file);
  assert.equal(new Set(files).size, files.length, 'each file once');
  assert.ok(answer.result.spread.set_aside >= 1);
});

test('indexes of different models are refused, not merged, and so are repeated or missing index ids', async () => {
  await assert.rejects(findSimilarAcross(across, { door: acrossWorld({ second: { model_id: 'another-model' } }) }), /different models/);
  for (const index_ids of [undefined, [], ['synthetic-pictures', 'synthetic-pictures'], ['']]) {
    await assert.rejects(findSimilarAcross({ ...across, index_ids }, { door: acrossWorld() }), /Send index_ids/);
  }
});

test('words said: every word longer than two letters, case ignored, in the order the sets hold them, up to the limit', async () => {
  const said = [
    { clip: 'a.mp4', t: 0, end: 2, text: 'The ZORBLAX is on the table.' }, { clip: 'a.mp4', t: 3, end: 5, text: 'A zorblax, no table.' },
    { clip: 'b.mp4', t: 1, end: 2, text: 'Only a table.' }, { clip: 'b.mp4', t: 4, end: 6, text: 'Table, and a zorblax again' },
  ];
  const set = { items: { file: '/Sets/said.jsonl' }, points_to: { file: 'clip', start: 't', end: 'end', text: 'text' } };
  const door = () => standInDoor({ descriptors: [descriptor(set, { index_id: 'synthetic-said' })], files: { '/Sets/said.jsonl': lines(said) } });
  const all = await findWordsSaid({ index_ids: ['synthetic-said'], query_text: 'a Zorblax table' }, { door: door() });
  assert.deepEqual(all.lines.map(line => line.address), ['/Sets/said.jsonl#0', '/Sets/said.jsonl#1', '/Sets/said.jsonl#3']);
  assert.deepEqual(all.lines[0], { address: '/Sets/said.jsonl#0', file: 'a.mp4', start: 0, end: 2, text: 'The ZORBLAX is on the table.' });
  assert.equal((await findWordsSaid({ index_ids: ['synthetic-said'], query_text: 'zorblax', limit: 1 }, { door: door() })).lines.length, 1);
  assert.deepEqual((await findWordsSaid({ index_ids: ['synthetic-said'], query_text: 'it is' }, { door: door() })).lines, [], 'no word longer than two letters matches nothing');
  await assert.rejects(findWordsSaid({ index_ids: ['synthetic-said'] }, { door: door() }), /query_text/);
});

test('words said refuses a set that names no text field', async () => {
  const door = standInDoor({ descriptors: [descriptor(SET, { index_id: 'synthetic-pictures' })], files: { '/Sets/frames.jsonl': lines(ITEMS) } });
  await assert.rejects(findWordsSaid({ index_ids: ['synthetic-pictures'], query_text: 'zorblax' }, { door }), /needs vector_set/);
});

const keptHelper = fileURLToPath(new URL('./kept_vectors_check.py', import.meta.url));

test('make_vector_set_from_kept_vectors: a matrix and its ids, and a results store, become vector sets the seam reads', { skip: canBuild ? false : 'needs python3 with numpy' }, () => {
  const ran = spawnSync('python3', ['-I', '-B', keptHelper], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
  assert.match(ran.stdout, /all tests passed/);
});
