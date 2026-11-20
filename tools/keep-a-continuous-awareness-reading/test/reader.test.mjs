import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awarenessReader } from '../src/reader.mjs';
import { awarenessInputs } from '../src/inputs.mjs';
import { awarenessQuestions } from '../src/questions.mjs';
import { askAwarenessModel } from '../src/ask-model.mjs';
import { replyObject, NotJson } from '../src/reply.mjs';
import { mapAreas } from '../../place-pursuits-on-a-life-map/src/life-map.mjs';
import { settings, mapSettings } from './made-up-settings.mjs';
import { openStore, addMessage } from './sql-store.mjs';

const memory = value => {
  let current = value;
  return { read: () => current, write: next => { current = next; } };
};

const NO_AI = Object.assign(new Error('No AI answered.'), { no_chosen_ai: true });

const answer = {
  trajectory: 'Moving toward a bakery of her own.',
  traits: { values: [{ name: 'Craft', evidence: [{ quote: 'Bread costs more than I thought.', source_id: '2' }] }], skills: [] },
  pursuits: [{
    title: 'Open a bakery', trajectory: 'planning', now: 'planning', after: 'open',
    evidence: ['I started the bakery plan.'], judgements: { worth: { choice: 'yes', why: 'it matters to her' } },
    areas: ['body', 'nowhere'],
  }],
  observations: [{ about: 'Thinks about cost', stages: { aware: 'costs', focus: 'bread' } }],
  right_now: { doing: 'costing bread', judgement: { choice: 'on', why: 'on the path' }, nudge: '' },
  questions: [{ question: 'Where will the bakery be?', about: 'pursuits', guess: 'unknown', why: 'needed for planning' }],
};

function harness({ reply = answer, ask = null, map = null, allowed = true } = {}) {
  const { db, query } = openStore();
  addMessage(db, { id: 1, recorded_at: '2026-11-01T09:00:00Z', text: 'I started the bakery plan.' });
  addMessage(db, { id: 2, recorded_at: '2026-11-02T09:00:00Z', text: 'Bread costs more than I thought.' });
  let clock = Date.parse('2026-11-05T09:00:00Z');
  const state = {
    reading: memory(null), pending: memory(null), picture: memory(null), recorded: [],
  };
  const calls = [];
  const modelAsk = ask ?? (async (system, user) => { calls.push({ system, user }); return { reply, model: 'test-model' }; });
  const reader = awarenessReader({
    settings, allowed: () => allowed, reading: state.reading, pending: state.pending, picture: state.picture,
    inputs: awarenessInputs({ query, settings }),
    ask: modelAsk,
    // The pursuits the person recorded, which is what a reading records its found pursuits into.
    stated: async () => state.recorded,
    record: async pursuits => { state.recorded.push(...pursuits); return pursuits; },
    questions: awarenessQuestions({ query, settings, now: () => new Date(clock).toISOString() }),
    map, mapSettings: map ? mapSettings : null,
    consolidate: null, mergedAway: null,
    now: () => new Date(clock),
  });
  return { reader, state, calls, setClock: ms => { clock = ms; }, query, db };
}

test('a reading keeps the picture from the inputs, records the pursuit it found and keeps the question it asked', async () => {
  const { reader, state, calls, query } = harness();
  const result = await reader.runDue();
  assert.equal(result.read, true);
  assert.equal(result.items, 2, 'both messages were read');
  assert.equal(result.questions, 1);
  assert.deepEqual(result.pursuits, { added: 1, updated: 0, ended: 0, refused: 0 });
  assert.equal(state.picture.read().trajectory, 'Moving toward a bakery of her own.');
  assert.deepEqual(state.picture.read().traits.values[0].evidence, ['Bread costs more than I thought.']);
  assert.equal(state.recorded[0].title, 'Open a bakery');
  assert.equal(state.recorded[0].found_by, 'reading');
  assert.deepEqual(state.recorded[0].evidence[0].quote_or_fact, 'I started the bakery plan.');
  assert.equal(state.pending.read(), null, 'the pending request is cleared once its picture is kept');
  assert.equal(state.reading.read().read_count, 2);
  assert.equal(query('SELECT question FROM awareness_questions')[0].question, 'Where will the bakery be?');
  assert.match(calls[0].user, /"new_inputs"/);
  assert.match(calls[0].system, /Keep at most 5 pursuits/);
});

test('a second reading with nothing new is not due and does not ask a model', async () => {
  const { reader, calls } = harness();
  await reader.runDue();
  const again = await reader.runDue();
  assert.equal(again.read, false, 'nothing unread, nothing asked');
  assert.equal(calls.length, 1);
});

test('with no AI answering, the reading waits, and each miss waits twice as long (up to waiting_longest_minutes)', async () => {
  const { reader, state, setClock } = harness({ ask: async () => { throw NO_AI; } });
  const start = Date.parse('2026-11-05T09:00:00Z');
  const first = await reader.runDue();
  assert.equal(first.waiting, true);
  assert.equal(Date.parse(first.retry_at), start + 10 * 60_000, 'the first miss waits every_minutes');
  assert.equal(state.reading.read().waiting_misses, 1);
  setClock(start + 11 * 60_000);
  const second = await reader.runDue();
  assert.equal(Date.parse(second.retry_at), start + 11 * 60_000 + 20 * 60_000, 'the second miss waits twice as long');
  assert.equal(state.picture.read(), null, 'nothing was kept while it waits');
});

test('a reply that is not valid JSON is asked to be made valid once, with the repair words, and then read', async () => {
  const asked = [];
  const ask = async (system, user) => {
    asked.push({ system, user });
    return asked.length === 1 ? { reply: 'Here is my answer, sorry', model: 'm' } : { reply: JSON.stringify(answer), model: 'm' };
  };
  const { reader } = harness({ ask });
  const result = await reader.runDue();
  assert.equal(result.read, true);
  assert.equal(asked.length, 2);
  assert.equal(asked[1].system, settings.repair_instructions, 'the repair asks with the rows repair words');
  assert.equal(asked[1].user, 'Here is my answer, sorry', 'the words are handed back unchanged');
});

test('a reply with no trajectory is refused and nothing is kept', async () => {
  const { reader, state } = harness({ reply: { ...answer, trajectory: '' } });
  await assert.rejects(reader.runDue(), /without a trajectory/);
  assert.equal(state.picture.read(), null);
  assert.equal(state.reading.read(), null, 'the cursor did not move');
});

test('a person who is not allowed keeps no reading', async () => {
  const { reader, calls } = harness({ allowed: false });
  assert.deepEqual(await reader.runDue(), { read: false });
  assert.equal(await reader.nextDue(), null);
  assert.equal(calls.length, 0);
});

test('read() shows the picture, the reading state and the open questions', async () => {
  const { reader } = harness();
  await reader.runDue();
  const view = await reader.read();
  assert.equal(view.picture.trajectory, 'Moving toward a bakery of her own.');
  assert.equal(view.reading.read_count, 2);
  assert.equal(view.reading.history_done, true);
  assert.deepEqual(view.questions.questions, ['Where will the bakery be?']);
  assert.equal(view.map, undefined, 'no map when the person has none');
});

test('with the map, each pursuit keeps only the map areas it names, and read() places the pursuits on the map', async () => {
  const rows = [
    { id: 'body', title: 'Body', values: { area: 'Body', means: 'Health' } },
    { id: 'money', title: 'Money', values: { area: 'Money', means: 'Cash' } },
  ];
  const map = { list_id: 'your-map', areas: async () => mapAreas(rows) };
  const { reader, state, calls } = harness({ map, stated: [] });
  await reader.runDue();
  assert.match(calls[0].user, /"map_areas"/);
  assert.match(calls[0].system, /map area id/);
  const kept = state.picture.read().pursuits[0];
  assert.deepEqual(kept.areas, ['body'], 'an id that is not on the map is dropped');
  const view = await reader.read();
  assert.deepEqual(view.map.areas.find(area => area.id === 'body').pursuits, ['Open a bakery']);
  assert.deepEqual(view.map.missing.map(area => area.id), ['money'], 'a leaf no pursuit names is missing');
});

test('a reply is read as an object or as the text of a chat reply', () => {
  assert.deepEqual(replyObject({ choices: [{ message: { content: '{"a":1}' } }] }), { a: 1 });
  assert.deepEqual(replyObject({ a: 2 }), { a: 2 });
  assert.throws(() => replyObject('no json here'), NotJson);
});

test('the model road is asked with the purpose and the two messages, and its answer is returned as given', async () => {
  const seen = [];
  const calls = { answered: async (purpose, model, input) => { seen.push({ purpose, model, input }); return { reply: 'x', model: 'route-model' }; } };
  const ask = askAwarenessModel(calls);
  assert.deepEqual(await ask('SYSTEM', 'USER'), { reply: 'x', model: 'route-model' });
  assert.deepEqual(seen, [{
    purpose: 'awareness', model: null,
    input: { messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'USER' }] },
  }]);
  assert.throws(() => askAwarenessModel({}), TypeError);
});
