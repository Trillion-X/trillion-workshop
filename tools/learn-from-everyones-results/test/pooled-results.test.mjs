// The pool account's rows and the one answer they give: a result is placed at a shared situation's own meaning, the
// answer counts only situations close to the asked one, gives no row, no contributor and nothing under the minimum
// number of people, stays the same while the rows stay the same, and a withdrawal removes every row of one
// contributor. All people here are synthetic. The door is an in-memory stand-in for the records door.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addPooledResult, addPooledSituation, howSimilarResultsTurnedOut, randomizeAResult, withdrawPooledResults } from '../read-data/pooled-results.mjs';
import { truthProbability } from '../read-data/pooled-learning.mjs';

const settings = JSON.parse(readFileSync(new URL('../read-data/pooled-results.json', import.meta.url), 'utf8'));
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(row => row.payload);
const rules = { epsilon: 1.0986, min_people: 10, shards: 16, query_epsilon: 1, people_bucket: 5, share_step: 0.05, min_similarity: 0.55 };
const situationType = `record:${settings.situations.row_type}`;
const resultType = `record:${settings.results.row_type}`;

function memoryDoor() {
  const records = new Map();
  return {
    records,
    async read(type, id) { const kept = records.get(id); return kept && kept.type === type ? structuredClone(kept.value) : null; },
    async *list({ type, prefix = '', fields }) {
      for (const id of [...records.keys()].sort().reverse()) {
        const kept = records.get(id);
        if (kept.type !== type || !id.startsWith(prefix)) continue;
        yield { id, type, value: fields ? Object.fromEntries(fields.filter(name => name in kept.value).map(name => [name, kept.value[name]])) : kept.value };
      }
    },
    async write(list) {
      assert.ok(list.length >= 1 && list.length <= settings.limits.writes);
      for (const { id, type, value } of list) {
        if (value === null) records.delete(id); else records.set(id, { type, value: structuredClone(value) });
      }
      return { changed: list.length, write_count: list.length };
    },
  };
}

const hex = n => n.toString(16).padStart(64, '0');
const situation = (door, id, embedding) => door.records.set(`${situationType}:${id}`, { type: situationType, value: { embedding } });
const near = [1, 0.1, 0, 0];
const far = [0, 0, 1, 0.2];

async function pool(door, { from = 0, people, at, workedShare }) {
  for (let i = from; i < from + people; i += 1) {
    await addPooledResult({ contributor: hex(i), situation: at, worked: randomizeAResult({ worked: i - from < people * workedShare, rules }).worked }, { door });
  }
}

test('the bit a store sends is the truth about three times in four, drawn from a cryptographic source', () => {
  let truthful = 0;
  for (let i = 0; i < 4000; i += 1) truthful += randomizeAResult({ worked: true, rules }).worked ? 1 : 0;
  assert.ok(Math.abs(truthful / 4000 - truthProbability(rules.epsilon)) < 0.03, `truthful ${truthful / 4000}`);
  assert.throws(() => randomizeAResult({ worked: 'yes', rules }), /true or false/);
  assert.throws(() => randomizeAResult({ worked: true, rules: {} }), /epsilon/);
});

test('a result row takes the shared situation\'s meaning, and only a shared situation takes results', async () => {
  const door = memoryDoor();
  situation(door, 's1', near);
  await addPooledResult({ contributor: hex(1), situation: 's1', worked: true, embedding: far }, { door });
  const [kept] = [...door.records.values()].filter(row => row.type === resultType);
  assert.deepEqual(kept.value.embedding, near, 'an embedding the sender names is never used');
  assert.deepEqual(Object.keys(kept.value).sort(), ['contributor', 'day', 'embedding', 'situation', 'worked']);
  await assert.rejects(addPooledResult({ contributor: hex(1), situation: 'nope', worked: true }, { door }), /No shared situation/);
  await assert.rejects(addPooledResult({ contributor: 'me', situation: 's1', worked: true }, { door }), /64 lowercase hex/);
  await assert.rejects(addPooledResult({ contributor: hex(1), situation: 's1', worked: 1 }, { door }), /true or false/);
});

test('the answer counts only close situations and gives no row, contributor or count under the minimum', async () => {
  const door = memoryDoor();
  situation(door, 'close', near);
  situation(door, 'other', far);
  await pool(door, { people: 60, at: 'close', workedShare: 0.5 });
  await pool(door, { from: 60, people: 40, at: 'other', workedShare: 1 });
  const answer = await howSimilarResultsTurnedOut({ embedding: [1, 0, 0, 0], rules }, { door });
  assert.deepEqual(Object.keys(answer).sort(), ['enough', 'people_at_least', 'worked_share']);
  assert.equal(answer.enough, true);
  assert.equal(answer.people_at_least, 60, 'the 40 people at a far situation are not counted');

  const few = memoryDoor();
  situation(few, 'close', near);
  await pool(few, { people: rules.min_people - 1, at: 'close', workedShare: 1 });
  assert.deepEqual(await howSimilarResultsTurnedOut({ embedding: near, rules }, { door: few }), { enough: false, people_at_least: 5 });
});

test('one person sending many results counts once', async () => {
  const door = memoryDoor();
  situation(door, 'close', near);
  await pool(door, { people: 30, at: 'close', workedShare: 0.5 });
  for (let i = 0; i < 50; i += 1) await addPooledResult({ contributor: hex(999), situation: 'close', worked: true }, { door });
  assert.equal((await howSimilarResultsTurnedOut({ embedding: near, rules }, { door })).people_at_least, 30);
});

test('the same question over the same rows gets the same answer; a withdrawal removes every row of one person', async () => {
  const door = memoryDoor();
  situation(door, 'close', near);
  await pool(door, { people: 60, at: 'close', workedShare: 0.5 });
  await addPooledResult({ contributor: hex(0), situation: 'close', worked: false }, { door });
  const first = await howSimilarResultsTurnedOut({ embedding: near, rules }, { door });
  assert.deepEqual(await howSimilarResultsTurnedOut({ embedding: near, rules }, { door }), first);
  assert.deepEqual(await withdrawPooledResults({ contributor: hex(0) }, { door }), { removed: 2 });
  assert.ok(![...door.records.values()].some(row => row.value.contributor === hex(0)));
  assert.equal((await howSimilarResultsTurnedOut({ embedding: near, rules }, { door })).people_at_least, 55);
  assert.deepEqual(await withdrawPooledResults({ contributor: hex(0) }, { door }), { removed: 0 });
});

test('a withdrawal larger than one write is sent in writes the engine takes', async () => {
  const door = memoryDoor();
  situation(door, 'close', near);
  for (let i = 0; i < settings.limits.writes + 7; i += 1) await addPooledResult({ contributor: hex(5), situation: 'close', worked: true }, { door });
  assert.deepEqual(await withdrawPooledResults({ contributor: hex(5) }, { door }), { removed: settings.limits.writes + 7 });
});

test('every rule is the caller\'s: an answer with a rule missing is refused', async () => {
  const door = memoryDoor();
  for (const name of Object.keys(rules)) {
    const { [name]: _gone, ...without } = rules;
    await assert.rejects(howSimilarResultsTurnedOut({ embedding: near, rules: without }, { door }), new RegExp(name));
  }
  await assert.rejects(howSimilarResultsTurnedOut({ embedding: near }, { door }), /rules/);
  await assert.rejects(howSimilarResultsTurnedOut({ embedding: ['x'], rules }, { door }), /list of numbers/);
});

test('the tool rows reach only the two row types this folder keeps, and never write from the read', () => {
  const rights = id => rows.find(row => row.id === id).invoke.records?.rights ?? [];
  const kinds = id => new Set(rights(id).map(right => right.kind));
  assert.deepEqual([...kinds('tool:add-a-pooled-result')].sort(), [resultType, situationType].sort());
  assert.deepEqual([...kinds('tool:withdraw-pooled-results')], [resultType]);
  assert.deepEqual(rights('tool:how-similar-results-turned-out'), [{ kind: resultType, operations: ['records:list'] }]);
  assert.deepEqual(rights('tool:randomize-a-result'), [], 'the person\'s own bit needs no records');
});

test('a shared situation enters the pool only in general words, under a new random id, with no sender', async () => {
  const door = memoryDoor();
  const entry = { situation: 'Someone with a steady job weighed starting a small business on the side.', options: ['Keep the job', 'Leave the job'], chosen: 'Keep the job', why: 'It pays the bills while the idea is tested.', measured_by: 'A first paying customer within a season.' };
  const { situation } = await addPooledSituation({ entry, embedding: [1, 0, 0, 0] }, { door });
  assert.match(situation, /^[0-9a-f-]{36}$/);
  const kept = door.records.get(`${situationType}:${situation}`);
  assert.deepEqual(Object.keys(kept.value).sort(), ['day', 'embedding', 'entry']);
  assert.deepEqual(kept.value.entry, entry);
  for (const unsafe of [{ ...entry, why: 'Orla at the Quokka Club said so.' }, { ...entry, situation: 'A shop in Seattle weighed a second site.' }, { ...entry, measured_by: 'Mail plans@example.test by spring.' }]) {
    await assert.rejects(addPooledSituation({ entry: unsafe, embedding: [1, 0, 0, 0] }, { door }), new RegExp(settings.words.not_safe.slice(0, 20)));
  }
  await assert.rejects(addPooledSituation({ entry: 'Keep the job', embedding: [1, 0, 0, 0] }, { door }), /shared entry is an object/);
  await assert.rejects(addPooledSituation({ entry, embedding: 'close' }, { door }), /An embedding/);
  assert.equal(door.records.size, 1, 'nothing unsafe was kept');
  // A result can then land on it, at its meaning.
  await addPooledResult({ contributor: hex(7), situation, worked: true }, { door });
  assert.deepEqual([...door.records.values()].find(row => row.type === resultType).value.embedding, [1, 0, 0, 0]);
});
