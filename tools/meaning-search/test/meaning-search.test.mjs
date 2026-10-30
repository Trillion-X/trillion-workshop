// The Workshop seam of meaning-search on synthetic vector sets: a stand-in door holds one descriptor record and the
// set's files, and the package's own scripts index and rank them. Nothing here is anyone's data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findSimilar, findSimilarVector } from '../read-data/meaning-search.mjs';
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
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  assert.deepEqual(rows.map(row => row.invoke.argv.at(-1)), ['findSimilarVector', 'findSimilar']);
  for (const row of rows) {
    assert.equal(row.invoke.internet, false);
    for (const right of row.invoke.records.rights) assert.ok(right.operations.every(operation => ['records:list', 'read_file'].includes(operation)));
  }
});
