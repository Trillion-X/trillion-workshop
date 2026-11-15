// Synthetic index descriptors, files and a local embedding endpoint exercise the account search's real readers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { searchEverything } from '../do-work/search-everything.mjs';
import { mintCanonicalMultihashOfText } from '../meaning/do-work/process-scripts/canonical_multihash.mjs';

const KIND = 'semantic-index-descriptor';
const lines = items => Buffer.from(items.map(item => JSON.stringify(item)).join('\n') + '\n');
function npy(rows) {
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${rows.length}, ${rows[0].length}), }`;
  header += ' '.repeat(63 - ((10 + header.length) % 64)) + '\n';
  const lead = Buffer.alloc(10);
  Buffer.from('\x93NUMPY', 'latin1').copy(lead);
  lead[6] = 1;
  lead.writeUInt16LE(header.length, 8);
  const data = Buffer.alloc(rows.length * rows[0].length * 4);
  rows.flat().forEach((value, at) => data.writeFloatLE(value, at * 4));
  return Buffer.concat([lead, Buffer.from(header), data]);
}

async function embedder({ fail = false } = {}) {
  const asked = [];
  const server = createServer((request, reply) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const sent = JSON.parse(body);
      asked.push({ path: request.url, ...sent });
      reply.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify(fail ? { error: 'synthetic model unavailable' } : { embedding: [1, 0] }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, asked, close: () => new Promise(done => server.close(done)) };
}

function fixture(endpoint, { discoveryError = null } = {}) {
  const calls = [];
  const descriptors = [];
  const files = {};
  const add = (id, points, items, vectors, extra = {}) => {
    descriptors.push({ kind: KIND, index_id: id, model_id: `model-${id}`, model_version: '1', model_endpoint: endpoint,
      descriptor_revision: mintCanonicalMultihashOfText(`synthetic descriptor ${id}`), model_provenance_ref: `model:model-${id}@1`,
      search_mode: 'exact', min_score: 0, result_limit: 10,
      vector_set: { items: { file: `/sets/${id}.jsonl` }, vectors: { file: `/sets/${id}.npy` }, points_to: points }, ...extra });
    files[`/sets/${id}.jsonl`] = lines(items);
    files[`/sets/${id}.npy`] = npy(vectors);
  };
  add('speech', { file: 'clip', start: 'at', end: 'until', text: 'words' }, [
    { clip: '/shared/Quartzbeacon.mp4', at: 12.345, until: 14, words: 'Quartzbeacon at the dock' },
    { clip: '/shared/Quartzbeacon.mp4', at: 30, until: 32, words: 'Quartzbeacon later' },
  ], [[1, 0], [0.8, 0.6]]);
  add('pictures', { file: 'clip', start: 'at' }, [{ clip: '/shared/Quartzbeacon.mp4', at: 12.5 }], [[1, 0]]);
  add('notes', { file: 'clip', text: 'words' }, [{ clip: '/notes/field.txt', words: 'Quartzbeacon field notes' }], [[1, 0]]);
  const door = {
    async *list(input) {
      calls.push({ method: 'records:list', input });
      assert.deepEqual(input, { type: KIND });
      if (discoveryError) throw discoveryError;
      // More than one iterator yield catches implementations that inspect only an initial inventory chunk.
      for (const [at, value] of descriptors.entries()) yield { id: `descriptor:${at}`, type: KIND, value };
    },
    async search(input) {
      calls.push({ method: 'records:search', input });
      return { results: [{ id: 'record:r1', record: 'r1', type: 'note', said: 'Quartzbeacon list row', score: 1 / 61,
        address: { resource: '@own-records', operation: 'records:read', input: { type: 'note', id: 'r1' } } }], unavailable: [], pending: [] };
    },
    async files(method, input) {
      calls.push({ method, input });
      if (method === 'search') return { results: [{ id: 'file:/shared/Quartzbeacon.mp4', identity: '/shared/Quartzbeacon.mp4', name: 'Quartzbeacon.mp4', score: 0.8 / 61,
        address: { resource: '@namespace', operation: 'find_file', input: { name_or_identity: '/shared/Quartzbeacon.mp4' } } }], unavailable: [], pending: [] };
      assert.equal(method, 'read_file');
      const bytes = files[input.name_or_identity];
      assert.ok(bytes, `unexpected read ${input.name_or_identity}`);
      const part = bytes.subarray(input.offset, input.offset + input.length);
      return { byte_length: bytes.length, encoding: 'base64', content: part.toString('base64') };
    },
  };
  return { door, calls, descriptors, files };
}

test('picture query encoding is model-checked and reused across that model indexes', async () => {
  const { door, descriptors, files } = fixture('http://127.0.0.1:9');
  const picture = descriptors.find(item => item.index_id === 'pictures');
  Object.assign(picture, { model_id: 'open_clip ViT-B-32', model_version: 'openai' });
  const vector = Array(512).fill(0); vector[0] = 1;
  files['/sets/pictures.npy'] = npy([vector]);
  descriptors.push({ ...picture, index_id: 'pictures-second' });
  let encoded = 0;
  door.run = async (tool, input) => {
    encoded++;
    assert.equal(tool, 'tool:words-as-picture-vector');
    assert.deepEqual(input, { texts: ['Quartzbeacon'] });
    return { result: { model: { name: 'ViT-B-32', pretrained: 'openai' }, dims: 512, vectors: [vector] } };
  };
  const answer = await searchEverything({ question: 'Quartzbeacon', places: ['seen'] }, { door });
  assert.equal(encoded, 1);
  assert.deepEqual(answer.unavailable, []);
  assert.equal(answer.results.length, 1);
  assert.equal(answer.results[0].moments[0].evidence.length, 2);
  assert.ok(answer.results[0].moments[0].evidence.every(item => item.score === 1 && item.model_id === 'open_clip ViT-B-32'));

  door.run = async () => ({ model: { name: 'ViT-B-32', pretrained: 'different-weights' }, dims: 512, vectors: [vector] });
  const refused = await searchEverything({ question: 'Quartzbeacon', places: ['seen'] }, { door });
  assert.deepEqual(refused.results, []);
  assert.equal(refused.unavailable.length, 2);
  assert.ok(refused.unavailable.every(item => item.reason === 'query_model_mismatch'));
});

test('carried namespace identities fuse a source path with its named account file', async () => {
  const model = await embedder();
  try {
    const { door, descriptors, files } = fixture(model.url);
    const picture = descriptors.find(item => item.index_id === 'pictures');
    picture.vector_set.points_to.carry = ['b2'];
    files['/sets/pictures.jsonl'] = lines([{ clip: '/source/Quartzbeacon.mp4', at: 12.5, b2: '/shared/Quartzbeacon.mp4' }]);
    const answer = await searchEverything({ question: 'Quartzbeacon', places: ['name', 'seen'] }, { door });
    assert.deepEqual(answer.unavailable, []);
    assert.equal(answer.results.length, 1);
    assert.equal(answer.results[0].identity, '/shared/Quartzbeacon.mp4');
    assert.deepEqual(answer.results[0].found_in, ['name', 'seen']);
    assert.equal(answer.results[0].address.input.name_or_identity, '/shared/Quartzbeacon.mp4');
  } finally { await model.close(); }
});

test('one question searches every list, name, spoken line, picture and written file, fusing one file and keeping moment evidence', async () => {
  const model = await embedder();
  try {
    const { door, calls } = fixture(model.url);
    const answer = await searchEverything({ question: '  Quartzbeacon  ' }, { door });
    assert.deepEqual(answer.unavailable, []);
    assert.deepEqual(answer.pending, []);
    assert.equal(answer.question, 'Quartzbeacon');
    assert.deepEqual(answer.terms, ['quartzbeacon']);
    assert.equal(calls.filter(call => call.method === 'records:list').length, 1, 'all index readers share one descriptor discovery');
    for (const method of ['records:search', 'search']) assert.equal(calls.find(call => call.method === method).input.question, answer.question);
    assert.equal(model.asked.length, 3, 'each descriptor uses its own model');
    assert.ok(model.asked.every(call => call.prompt === answer.question), 'every model gets the same normalized question');
    assert.deepEqual(model.asked.map(call => call.model).sort(), ['model-notes', 'model-pictures', 'model-speech']);
    assert.deepEqual([...new Set(answer.results.flatMap(hit => hit.found_in))].sort(), ['name', 'said', 'seen', 'written']);
    assert.equal(answer.results.filter(hit => hit.identity === '/shared/Quartzbeacon.mp4').length, 1);
    const shared = answer.results[0];
    assert.equal(shared.identity, '/shared/Quartzbeacon.mp4', 'several independent rankings lift the shared file first');
    assert.deepEqual([...shared.found_in].sort(), ['name', 'said', 'seen']);
    assert.equal(shared.score, Math.round((0.8 + 1 + 1 + 1) / 61 * 1e5) / 1e5, 'a second moment does not add another vote in one ranking');
    assert.ok(answer.results.some(hit => hit.record === 'r1'), 'list results retain their readable address');
    assert.ok(answer.results.some(hit => hit.identity === '/notes/field.txt' && hit.found_in.includes('written')));
    const later = shared.moments.find(moment => moment.start === 30);
    assert.equal(later.end, 32);
    assert.equal(later.said, 'Quartzbeacon later');
    assert.deepEqual(later.evidence.map(one => one.match).sort(), ['meaning', 'words']);
    const meaning = later.evidence.find(one => one.match === 'meaning');
    assert.equal(meaning.index_id, 'speech');
    assert.equal(meaning.address, '/sets/speech.jsonl#1');
    assert.equal(meaning.model_id, 'model-speech');
    assert.equal(meaning.model_version, '1');
    assert.ok(Math.abs(meaning.score - 0.8) < 1e-6, 'the raw cosine is preserved apart from the fused score');
    assert.equal(later.evidence.find(one => one.match === 'words').score, 0.5);
    const first = shared.moments.find(moment => moment.timed && moment.start < 13);
    assert.ok(first.places.includes('said') && first.places.includes('seen'), 'nearby spoken and picture moments merge');
    assert.ok(first.evidence.some(one => one.index_id === 'pictures'));
  } finally { await model.close(); }
});

test('supplied model vectors keep index scoping and never cross model identities', async () => {
  const model = await embedder();
  try {
    const { door, calls, descriptors } = fixture(model.url);
    descriptors.find(item => item.index_id === 'pictures').min_score = 0.5;
    const vector_base64 = Buffer.from(JSON.stringify({ vector: [0, 1] })).toString('base64');
    const answer = await searchEverything({ question: 'Quartzbeacon', places: ['seen', 'written'], index_ids: ['pictures', 'notes'],
      query_vectors: [{ model_id: 'model-pictures', model_version: '1', vector_base64 }] }, { door });
    assert.deepEqual(model.asked.map(call => call.model), ['model-notes']);
    assert.ok(calls.filter(call => call.method === 'read_file').every(call => !call.input.name_or_identity.includes('speech')));
    assert.ok(!answer.results.some(hit => hit.found_in.includes('seen')), 'the supplied orthogonal vector cannot match the picture');
    assert.ok(answer.results.some(hit => hit.identity === '/notes/field.txt'), 'the other model embeds its own query');
    assert.deepEqual(answer.unavailable, []);
  } finally { await model.close(); }
});

test('a failed model leaves literal spoken and written matches, and names each unavailable model lane', async () => {
  const model = await embedder({ fail: true });
  try {
    const { door } = fixture(model.url);
    const answer = await searchEverything({ question: 'Quartzbeacon' }, { door });
    assert.deepEqual(answer.unavailable.map(item => [item.lane, item.place, item.source]).sort(), [
      ['index-said:speech:meaning', 'said', 'files'], ['index-seen:pictures:meaning', 'seen', 'files'], ['index-written:notes:meaning', 'written', 'files'],
    ]);
    assert.ok(answer.unavailable.every(item => typeof item.reason === 'string' && item.reason.length));
    assert.ok(answer.results.some(hit => hit.found_in.includes('said')));
    assert.ok(answer.results.some(hit => hit.identity === '/notes/field.txt'));
    const evidence = answer.results.flatMap(hit => hit.moments.flatMap(moment => moment.evidence ?? []));
    assert.ok(evidence.some(one => one.match === 'words'));
    assert.ok(evidence.every(one => one.match !== 'meaning'));
  } finally { await model.close(); }
});

test('the same trimmed 500-character question reaches record, filename and model searches', async () => {
  const model = await embedder();
  try {
    const { door, calls } = fixture(model.url);
    const question = `  Quartzbeacon ${'x'.repeat(510)}  `;
    const expected = question.trim().slice(0, 500);
    const answer = await searchEverything({ question }, { door });
    assert.equal(answer.question, expected);
    assert.equal(answer.question.length, 500);
    for (const method of ['records:search', 'search']) assert.equal(calls.find(call => call.method === method).input.question, expected);
    assert.equal(model.asked.length, 3);
    assert.ok(model.asked.every(call => call.prompt === expected));
  } finally { await model.close(); }
});

test('places, sources and record type avoid irrelevant searches, descriptors, models and file reads', async () => {
  const model = await embedder();
  try {
    for (const input of [{ places: ['name'] }, { sources: ['trillion'] }, { type: 'note' }]) {
      const { door, calls } = fixture(model.url);
      await searchEverything({ question: 'Quartzbeacon', ...input }, { door });
      assert.deepEqual(calls.map(call => call.method), input.places ? ['search'] : ['records:search']);
    }
    assert.deepEqual(model.asked, []);
    const { door, calls } = fixture(model.url);
    const answer = await searchEverything({ question: 'Quartzbeacon', places: ['seen'], sources: ['files'] }, { door });
    assert.deepEqual(answer.results[0].found_in, ['seen']);
    assert.ok(calls.every(call => !['search', 'records:search'].includes(call.method)));
    assert.deepEqual([...new Set(calls.filter(call => call.method === 'read_file').map(call => call.input.name_or_identity))].sort(), ['/sets/pictures.jsonl', '/sets/pictures.npy']);
    assert.deepEqual(model.asked.map(call => call.model), ['model-pictures']);
  } finally { await model.close(); }
});

test('an explicit descriptor place overrides its field-based classification', async () => {
  const model = await embedder();
  try {
    const { door, descriptors, calls } = fixture(model.url);
    descriptors[0].place = 'written';
    const answer = await searchEverything({ question: 'Quartzbeacon', places: ['said'] }, { door });
    assert.deepEqual(answer.results, []);
    assert.deepEqual(calls.map(call => call.method), ['records:list']);
    assert.deepEqual(model.asked, []);
  } finally { await model.close(); }
});

test('a descriptor discovery failure names every requested index place unavailable instead of claiming complete search', async () => {
  const error = Object.assign(new Error('synthetic descriptor refusal'), { code: 'current_workspace_rights_refused' });
  const { door, calls } = fixture('http://127.0.0.1:9', { discoveryError: error });
  const answer = await searchEverything({ question: 'Quartzbeacon' }, { door });
  assert.deepEqual(answer.unavailable.map(item => [item.lane, item.reason]).sort(), [
    ['index-said', error.code], ['index-seen', error.code], ['index-written', error.code],
  ]);
  assert.equal(calls.filter(call => call.method === 'records:list').length, 1);
  assert.ok(answer.results.some(hit => hit.record === 'r1'), 'an unavailable inventory leaves the other answers intact');
});
