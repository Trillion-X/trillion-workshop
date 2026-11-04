// The one search, against stand-in doors: the merge moved from the engine, the files lane named when it cannot answer,
// `type` leaving the files out, and 10,000 rows across 3 lists (a word only row 9,731 holds comes back first and reads
// back through its address). The container row runs as the runner runs it, against the fake records door with exactly
// its rights. Every record and name here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordsDoorFromCall, RecordsDoorError } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { searchEverything } from '../do-work/search-everything.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const K = 60;
const wordsOf = text => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const termsOf = question => [...new Set(wordsOf(String(question).slice(0, 500)))].filter(word => word.length >= 2);

// The person's own door, as the engine answers it: records:search over every kind through a word index built as the
// records are written (each kind its own lane, 1 / (k + rank)), and the files' name search (0.8 / (k + rank)).
function personDoor({ records = [], files = [], filesRefused = null, recordsRefused = null } = {}) {
  const kept = new Map(records.map(record => [record.id, record]));
  const index = new Map();
  for (const record of records) for (const word of new Set(wordsOf(JSON.stringify(record.value)))) {
    for (let end = 2; end <= word.length; end += 1) {
      const start = word.slice(0, end);
      if (!index.has(start)) index.set(start, new Set());
      index.get(start).add(record.id);
    }
  }
  const asked = [];
  const operations = {
    'records:read': ({ id, type }) => ({ id, type, value: kept.get(id)?.type === type || !type ? kept.get(id)?.value ?? null : null }),
    'records:search': ({ question, type, limit = 60 }) => {
      if (recordsRefused) throw new RecordsDoorError(recordsRefused, 'refused', 'not_started');
      const terms = termsOf(question);
      let ids = null;
      for (const term of terms) {
        const holding = index.get(term) ?? new Set();
        ids = ids === null ? new Set(holding) : new Set([...ids].filter(id => holding.has(id)));
      }
      const lanes = new Map();
      for (const id of [...(ids ?? [])].sort()) {
        const record = kept.get(id);
        if (type && record.type !== type) continue;
        if (!lanes.has(record.type)) lanes.set(record.type, []);
        lanes.get(record.type).push(record);
      }
      const results = [...lanes.values()].flatMap(lane => lane.map((record, at) => ({
        id: `record:${record.id}`, source: 'trillion', type: record.type, record: record.id, title: record.value.title, found_in: ['written'],
        said: record.value.notes, address: { resource: '@own-records', operation: 'records:read', input: { id: record.id, type: record.type } },
        score: Math.round(1e5 / (K + at + 1)) / 1e5,
      }))).sort((a, b) => b.score - a.score).slice(0, limit);
      return { question, terms, results, unavailable: [], pending: [] };
    },
    search: ({ question, limit = 60 }) => {
      if (filesRefused) throw new RecordsDoorError(filesRefused, 'refused', 'not_started');
      const terms = termsOf(question);
      const results = files.filter(name => terms.every(term => wordsOf(name.split('/').at(-1)).some(word => word.startsWith(term)))).slice(0, limit)
        .map((path, at) => ({ id: `file:${path}`, source: 'files', name: path.split('/').at(-1), path, found_in: ['name'],
          address: { resource: '@namespace', operation: 'find_file', input: { name_or_identity: path } }, score: 0.8 / (K + at + 1) }));
      return { question, terms, results, unavailable: [], pending: [] };
    },
  };
  const call = async (method, input, _key, address) => {
    asked.push({ method, address, input });
    return operations[method](input);
  };
  return { door: recordsDoorFromCall(call, { resource: '@own-records', filesResource: '@namespace' }), asked };
}

test('lanes merge by reciprocal rank and keep what could not answer (old finish, which the engine\'s merged ported)', async () => {
  const door = recordsDoorFromCall(async (method, input) => (method === 'records:search'
    ? { question: input.question, terms: ['q'], results: [
      { id: 'record:a', type: 'alpha', record: 'a', said: 'q a', score: 0.01639 },
      { id: 'record:b', type: 'alpha', record: 'b', said: 'q b', score: 0.01613 },
      { id: 'record:c', type: 'beta', record: 'c', said: 'q c', score: 0.01639 }], unavailable: [], pending: [{ place: 'said' }] }
    : { results: [{ id: 'file:f', identity: 'f', name: 'q.txt', score: 0.01311 }], unavailable: [], pending: [] }), { resource: '@own-records', filesResource: '@namespace' });
  const answer = await searchEverything({ question: 'quill', limit: 4 }, { door });
  // The first of each kind ties at 1 / (k + 1); alpha's second is worth 1 / (k + 2), above the file's 0.8 / (k + 1).
  assert.deepEqual(answer.results.map(hit => hit.id), ['record:a', 'record:c', 'record:b', 'file:f']);
  assert.deepEqual((await searchEverything({ question: 'quill', limit: 2 }, { door })).results.map(hit => hit.id), ['record:a', 'record:c']);
  assert.equal(answer.results[0].score, answer.results[1].score);
  assert.equal(answer.results[0].score, Math.round(1e5 / 61) / 1e5);
  assert.deepEqual(answer.results[3].found_in, ['name']);
  assert.deepEqual(answer.pending, [{ place: 'said' }]);
  assert.deepEqual(answer.terms, ['quill']);
});

test('a search over 10,000 rows in three lists answers row 9,731 first, under 200 ms, and reads it back', async () => {
  const lists = ['list-a', 'list-b', 'list-c'];
  const records = [];
  for (let n = 1; n <= 10_000; n += 1) {
    const notes = n === 9_731 ? 'quartzbeacon left at the dock' : `plain row ${n} of the list`;
    records.push({ id: `row${String(n).padStart(5, '0')}`, type: lists[n % 3], value: { title: `row ${n}`, notes } });
  }
  const { door, asked } = personDoor({ records, files: ['/Notes/quartzbeacon dock plan.pdf', '/Notes/other.txt'] });
  const started = performance.now();
  const found = await searchEverything({ question: 'quartzbeacon' }, { door });
  const took = performance.now() - started;
  console.log(`search everything over 10,000 rows in 3 lists and the files: ${took.toFixed(1)} ms`);
  assert.ok(took < 200, `${took} ms`);
  assert.equal(found.results[0].record, 'row09731', JSON.stringify(found));
  // The file whose name holds the word comes after it (0.8 / 61 < 1 / 61), in the same ranked list.
  assert.deepEqual(found.results.map(hit => hit.id), ['record:row09731', 'file:/Notes/quartzbeacon dock plan.pdf']);
  assert.deepEqual(found.unavailable, []);
  const { address } = found.results[0];
  const read = await door.readRecord(address.input.type, address.input.id);
  assert.equal(read.value.notes, 'quartzbeacon left at the dock');
  // Both lanes were asked with the same question: the records with the whole input, the files with only the question.
  assert.deepEqual(asked.slice(0, 2).map(({ method, address }) => `${method} ${address}`).sort(), ['records:search @own-records', 'search @namespace']);
  assert.deepEqual(asked.find(item => item.method === 'search').input, { question: 'quartzbeacon' });
});

test('a caller the files refuse gets the records\' answer, with the files named unavailable, never guessed', async () => {
  const records = [{ id: 'r1', type: 'note', value: { title: 'kestrel', notes: 'kestrel seen' } }];
  const { door } = personDoor({ records, files: ['/kestrel.jpg'], filesRefused: 'current_workspace_rights_refused' });
  const found = await searchEverything({ question: 'kestrel', limit: 5 }, { door });
  assert.deepEqual(found.results.map(hit => hit.id), ['record:r1']);
  assert.deepEqual(found.unavailable, [{ lane: 'file-names', place: 'name', source: 'files', reason: 'current_workspace_rights_refused' }]);
  // A door handed no files right at all is refused before anything is sent, and named the same way.
  const bare = recordsDoorFromCall(async () => ({ question: 'kestrel', terms: ['kestrel'], results: [], unavailable: [], pending: [] }), { resource: '@own-records' });
  const none = await searchEverything({ question: 'kestrel' }, { door: bare });
  assert.deepEqual(none.unavailable, [{ lane: 'file-names', place: 'name', source: 'files', reason: 'no_files' }]);
});

test('with a type only that kind is asked, the files are not, and the records\' answer is answered as it is', async () => {
  const records = [
    { id: 'a1', type: 'alpha', value: { title: 'one', notes: 'kestrel one' } },
    { id: 'b1', type: 'beta', value: { title: 'two', notes: 'kestrel two' } },
  ];
  const { door, asked } = personDoor({ records, files: ['/kestrel.jpg'] });
  const found = await searchEverything({ question: 'kestrel', type: 'beta' }, { door });
  assert.deepEqual(found.results.map(hit => hit.record), ['b1']);
  assert.deepEqual(asked.map(item => item.method), ['records:search']);
});

test('a refusal of the records\' search is the answer\'s refusal', async () => {
  const { door } = personDoor({ recordsRefused: 'original_input_refused' });
  await assert.rejects(searchEverything({ question: 'x' }, { door }), error => error.code === 'original_input_refused');
});

test('the one-list row runs with a right on the kind its type names, and finds the row however far down it is', async () => {
  const row = rowOf(rows, 'tool:search-one-of-my-lists');
  const records = Array.from({ length: 600 }, (_, at) => ({ id: `n${String(at).padStart(4, '0')}`, type: 'note', value: { text: at === 577 ? 'zephyrine harbour' : `ordinary ${at}` } }));
  records.push({ id: 'x1', type: 'secret', value: { text: 'zephyrine elsewhere' } });
  const ran = await answerOf(row, { question: 'zephyrine', type: 'note' }, { records });
  assert.equal(ran.status, 0, JSON.stringify(ran));
  assert.deepEqual(ran.result.results.map(hit => hit.record), ['n0577']);
  assert.deepEqual(ran.calls.map(item => item.method), ['records:search']);
  // A kind the run was not granted is refused, not widened.
  const other = await answerOf({ ...row, invoke: { ...row.invoke, records: { fd: 3, rights: [{ kind: 'note', operations: ['records:search'] }] } } }, { question: 'zephyrine', type: 'secret' }, { records });
  assert.ok(other.error, JSON.stringify(other));
});
