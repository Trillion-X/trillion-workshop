// The pool's answer and the shared-situation row: the answer counts only situations close to the asked one, gives no row,
// contributor or count under the minimum number of people, stays the same while the rows stay the same, and a shared
// situation is answered as a row to keep. Writing and withdrawing a person's pooled results is workflow:keep-pooled-results
// (recipes/keep-pooled-results.json), proved on its own prove step. All people here are synthetic.
import { rightsOf } from '../../../test-helpers/run-a-row.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addPooledSituation, howSimilarResultsTurnedOut, randomizeAResult } from '../read-data/pooled-results.mjs';
import { truthProbability } from '../read-data/pooled-learning.mjs';

const settings = JSON.parse(readFileSync(new URL('../read-data/pooled-results.json', import.meta.url), 'utf8'));
const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(row => row.payload);
const rules = { epsilon: 1.0986, min_people: 10, shards: 16, query_epsilon: 1, people_bucket: 5, share_step: 0.05, min_similarity: 0.55 };
const situationType = `record:${settings.situations.row_type}`;
const resultType = `record:${settings.results.row_type}`;
const near = [1, 0.1, 0, 0];
const far = [0, 0, 1, 0.2];
const hex = n => n.toString(16).padStart(64, '0');

/** One pool result row as the pool's store keeps it: the randomized bit under a contributor, at the situation's meaning. */
function resultRow(contributor, meaning, worked, n) {
  return { id: `${resultType}:${contributor}:${n}`, value: { contributor, situation: 'shared', worked: worked ? 1 : 0, embedding: meaning, day: '2026-11-01' } };
}

/** People from `from` on, each sending the randomized bit for one result at `meaning`; `workedShare` of them truly worked. */
function pool(from, people, meaning, workedShare) {
  const out = [];
  for (let i = from; i < from + people; i += 1) {
    out.push(resultRow(hex(i), meaning, randomizeAResult({ worked: i - from < people * workedShare, rules }).worked, i));
  }
  return out;
}

test('the bit a store sends is the truth about three times in four, drawn from a cryptographic source', () => {
  let truthful = 0;
  for (let i = 0; i < 4000; i += 1) truthful += randomizeAResult({ worked: true, rules }).worked ? 1 : 0;
  assert.ok(Math.abs(truthful / 4000 - truthProbability(rules.epsilon)) < 0.03, `truthful ${truthful / 4000}`);
  assert.throws(() => randomizeAResult({ worked: 'yes', rules }), /true or false/);
  assert.throws(() => randomizeAResult({ worked: true, rules: {} }), /epsilon/);
});

test('the answer counts only close situations and gives no row, contributor or count under the minimum', () => {
  const results = [...pool(0, 60, near, 0.5), ...pool(60, 40, far, 1)];
  const answer = howSimilarResultsTurnedOut({ embedding: [1, 0, 0, 0], rules, results });
  assert.deepEqual(Object.keys(answer).sort(), ['enough', 'people_at_least', 'worked_share']);
  assert.equal(answer.enough, true);
  assert.equal(answer.people_at_least, 60, 'the 40 people at a far situation are not counted');

  const few = pool(0, rules.min_people - 1, near, 1);
  assert.deepEqual(howSimilarResultsTurnedOut({ embedding: near, rules, results: few }), { enough: false, people_at_least: 5 });
});

test('one person sending many results counts once', () => {
  const results = [...pool(0, 30, near, 0.5)];
  for (let i = 0; i < 50; i += 1) results.push(resultRow(hex(999), near, true, 1000 + i));
  assert.equal(howSimilarResultsTurnedOut({ embedding: near, rules, results }).people_at_least, 30);
});

test('the same question over the same rows gets the same answer, and leaving rows out changes it', () => {
  const results = [...pool(0, 60, near, 0.5), resultRow(hex(0), near, false, 500)];
  const first = howSimilarResultsTurnedOut({ embedding: near, rules, results });
  assert.deepEqual(howSimilarResultsTurnedOut({ embedding: near, rules, results }), first);
  const without = results.filter(row => row.value.contributor !== hex(0));
  assert.equal(howSimilarResultsTurnedOut({ embedding: near, rules, results: without }).people_at_least, 55);
});

test('every rule is the caller\'s: an answer with a rule missing is refused', () => {
  for (const name of Object.keys(rules)) {
    const { [name]: _gone, ...without } = rules;
    assert.throws(() => howSimilarResultsTurnedOut({ embedding: near, rules: without, results: [] }), new RegExp(name));
  }
  assert.throws(() => howSimilarResultsTurnedOut({ embedding: near, results: [] }), /rules/);
  assert.throws(() => howSimilarResultsTurnedOut({ embedding: ['x'], rules, results: [] }), /list of numbers/);
  assert.throws(() => howSimilarResultsTurnedOut({ embedding: near, rules }), /result rows/);
});

test('the answer is made from the result rows in the request alone: no store is handed to the run', () => {
  const results = [];
  for (let i = 0; i < 60; i += 1) results.push({ id: `r${i}`, value: { contributor: hex(i), worked: i % 2, embedding: near } });
  const answer = howSimilarResultsTurnedOut({ embedding: near, rules, results });
  assert.equal(answer.enough, true);
  assert.equal(answer.people_at_least, 60);
  assert.deepEqual(Object.keys(answer).sort(), ['enough', 'people_at_least', 'worked_share']);
  assert.deepEqual(howSimilarResultsTurnedOut({ embedding: near, rules, results }), answer, 'the same rows give the same answer');
});

test('no tool row keeps or reads records: the pool writes are the recipe, and every answering tool reaches none', () => {
  const rights = id => rightsOf(rows.find(row => row.id === id)) ?? [];
  assert.equal(rows.some(row => row.id === 'tool:add-a-pooled-result' || row.id === 'tool:withdraw-pooled-results'), false, 'both are workflow:keep-pooled-results now');
  for (const row of rows) {
    assert.deepEqual(rights(row.id), [], `${row.id} declares no records right`);
    assert.doesNotMatch(JSON.stringify(row), /"records:(read|write|list)"/, `${row.id} names no records method`);
  }
  assert.ok(rows.find(row => row.id === 'tool:how-similar-results-turned-out').input_schema.required.includes('results'));
  assert.deepEqual(rights('tool:randomize-a-result'), [], 'the person\'s own bit needs no records');
});

test('a shared situation is answered as a row to keep only in general words, under a new random id, with no sender', () => {
  const entry = { situation: 'Someone with a steady job weighed starting a small business on the side.', options: ['Keep the job', 'Leave the job'], chosen: 'Keep the job', why: 'It pays the bills while the idea is tested.', measured_by: 'A first paying customer within a season.' };
  const { situation, record } = addPooledSituation({ entry, embedding: [1, 0, 0, 0] });
  assert.match(situation, /^[0-9a-f-]{36}$/);
  assert.equal(record.id, `${situationType}:${situation}`);
  assert.equal(record.type, situationType);
  assert.deepEqual(Object.keys(record.value).sort(), ['day', 'embedding', 'entry']);
  assert.deepEqual(record.value.entry, entry);
  for (const unsafe of [{ ...entry, why: 'Orla at the Quokka Club said so.' }, { ...entry, situation: 'A shop in Seattle weighed a second site.' }, { ...entry, measured_by: 'Mail plans@example.test by spring.' }]) {
    assert.throws(() => addPooledSituation({ entry: unsafe, embedding: [1, 0, 0, 0] }), new RegExp(settings.words.not_safe.slice(0, 20)));
  }
  assert.throws(() => addPooledSituation({ entry: 'Keep the job', embedding: [1, 0, 0, 0] }), /shared entry is an object/);
  assert.throws(() => addPooledSituation({ entry, embedding: 'close' }), /An embedding/);
});
