import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awarenessInputs, messagesQuery, resultsQuery } from '../src/inputs.mjs';
import { settings } from './made-up-settings.mjs';
import { openStore, addMessage, addResult, addActivity } from './sql-store.mjs';

const inputsFor = (query, limits = {}) => awarenessInputs({ query, settings: { ...settings, inputs: { ...settings.inputs, ...limits } } });

test('the first reading reads the history the store already holds, oldest kept words first only once, and finishes it', async () => {
  const { db, query } = openStore();
  addMessage(db, { id: 1, recorded_at: '2026-11-01T09:00:00Z', text: 'I started the bakery plan.' });
  addMessage(db, { id: 2, recorded_at: '2026-11-02T09:00:00Z', text: 'Bread costs more than I thought.' });
  const inputs = inputsFor(query);
  const first = await inputs.read(null);
  assert.deepEqual(first.items.map(item => item.source_id), ['2', '1'], 'history is read newest first, each id as text');
  assert.equal(first.cursor.history_done, true, 'a page shorter than its limit finishes history');
  assert.equal(first.items[0].from, 'person in Claude');
});

test('a new message after the first reading is read as new, and nothing already read comes again', async () => {
  const { db, query } = openStore();
  addMessage(db, { id: 1, recorded_at: '2026-11-01T09:00:00Z', text: 'First thing.' });
  const inputs = inputsFor(query);
  const first = await inputs.read(null);
  assert.equal(await inputs.unread(first.cursor), false, 'nothing unread right after the first reading');
  addMessage(db, { id: 2, recorded_at: '2026-11-03T09:00:00Z', text: 'Second thing, new.' });
  assert.equal(await inputs.unread(first.cursor), true);
  const next = await inputs.read(first.cursor);
  assert.deepEqual(next.items.map(item => item.source_id), ['2']);
  assert.equal(next.cursor.new.message, '2026-11-03T09:00:00Z');
});

test('a read that runs out of budget keeps its cursor where it stopped, and history is read once across pages', async () => {
  const { db, query } = openStore();
  for (let id = 1; id <= 5; id += 1) addMessage(db, { id, recorded_at: `2026-11-0${id}T09:00:00Z`, text: `Message number ${id}.` });
  const inputs = inputsFor(query, { chars: 40, messages: 2 });
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const read = await inputs.read(cursor);
    seen.push(...read.items.map(item => item.source_id));
    cursor = read.cursor;
    if (read.cursor.history_done) break;
  }
  assert.deepEqual(seen, ['5', '4', '3', '2', '1'],'each message is read exactly once, newest history first');
  assert.equal(cursor.history_done, true);
});

test('results of the chosen kinds are read as text cut to result_chars; other kinds are not read', async () => {
  const { db, query } = openStore();
  addResult(db, { identity: 'file-aaaaaaaaaaaaaaaa', kind: 'transcript', recorded_at: '2026-11-01T10:00:00Z', value: 'The long transcript of the lesson.' });
  addResult(db, { identity: 'file-bbbbbbbbbbbbbbbb', kind: 'picture', recorded_at: '2026-11-01T11:00:00Z', value: 'Not a text result.' });
  addResult(db, { identity: 'file-cccccccccccccccc', kind: 'summary', recorded_at: '2026-11-01T12:00:00Z', value: 'A summary of the week, cut short.' });
  const inputs = inputsFor(query, { result_chars: 12 });
  const read = await inputs.read(null);
  const results = read.items.filter(item => item.kind !== 'message');
  assert.deepEqual(results.map(item => item.text), ['A summary of', 'The long tra'], 'newest first, each cut to 12 characters, the picture kind left out');
  assert.equal(results[0].from, 'file file-ccccccc', 'the source is the first 12 characters of its identity');
});

test('activity rides along only with a reading that read something else, and only the rows newer than the last reading', async () => {
  const { db, query } = openStore();
  addMessage(db, { id: 1, recorded_at: '2026-11-01T09:00:00Z', text: 'Before the reading.' });
  addActivity(db, { seq: 1, at: '2026-11-01T08:00:00Z', row: { label: 'Old call', title: 'before' } });
  const inputs = inputsFor(query);
  const first = await inputs.read(null);
  assert.equal(first.items.some(item => item.kind === 'activity'), false, 'the activity that existed at the first reading is not news');
  addActivity(db, { seq: 2, at: '2026-11-03T08:00:00Z', app: 'Claude', row: { label: 'Booked', title: 'a court', ok: false, reason: 'no slot' } });
  addMessage(db, { id: 2, recorded_at: '2026-11-03T09:00:00Z', text: 'Booked it.' });
  const next = await inputs.read(first.cursor);
  const activity = next.items.filter(item => item.kind === 'activity');
  assert.equal(activity.length, 1);
  assert.equal(activity[0].text, 'Booked a court (did not work: no slot)');
  assert.equal(next.cursor.new.activity, 2);
});

test('the SQL keeps every value as a parameter and orders result and message pages the way the cursor expects', () => {
  const results = resultsQuery({ kinds: ['transcript', 'summary'], from: ['t', 'i', 'k'], inclusive: true, order: 'DESC', limit: 3, chars: 9 });
  assert.match(results.sql, /kind IN \(\$1, \$2\)/);
  assert.match(results.sql, /\(recorded_at, identity, kind\) <= \(\$3, \$4, \$5\)/);
  assert.match(results.sql, /ORDER BY recorded_at DESC, identity DESC, kind DESC LIMIT \$7/);
  assert.deepEqual(results.params, ['transcript', 'summary', 't', 'i', 'k', 9, 3]);
  assert.doesNotMatch(results.sql, /transcript|summary/, 'kinds are parameters, never SQL text');
  const messages = messagesQuery({ before: 7, until: 'U', limit: 4 });
  assert.equal(messages.sql, 'SELECT id, recorded_at, speaker, app, at, text FROM messages WHERE id < $1 AND recorded_at <= $2 ORDER BY id DESC LIMIT $3');
  assert.deepEqual(messages.params, [7, 'U', 4]);
});
