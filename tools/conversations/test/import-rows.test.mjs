// tools/conversations/test/import-rows.test.mjs
//
// The import rows run the way the engine runs them: the files they pack laid at their places (here, under the folder
// the test names for /opt/conversations), their argv run as the engine runs it (test-helpers/run-a-row.mjs answerOf for the
// row that reads a granted folder alone), and their stdin filled with the input, the granted folder and the values the
// person's store holds. The store is played by the test (test/support/held-store.mjs): each run is handed what it asks
// for, and what it writes is kept there. A made-up Grok export and a Hermes session, laid in the granted folder, stand in
// for the person's files.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { heldStore } from './support/held-store.mjs';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));

// The person's files, laid in the folder the row's read-a-folder capability is granted.
const HOME = [
  { grant: 'read-a-folder', path: 'Downloads/grok/prod-grok-backend.json', text: JSON.stringify({ conversations: [{ conversation: { id: 'gk-1', title: 'Hydration' }, responses: [
    { response: { _id: 'gk-1-a', sender: 'human', message: 'What hydration for a country loaf?', create_time: { $date: { $numberLong: '1736000000000' } } } },
    { response: { _id: 'gk-1-b', sender: 'ASSISTANT', message: 'About 75 percent.', create_time: { $date: { $numberLong: '1736000003000' } } } }] }] }) },
  { grant: 'read-a-folder', path: '.hermes/sessions/session_1.json', text: JSON.stringify({ session_id: 'hermes-1', session_start: '2026-10-04T10:00:00Z', messages: [
    { role: 'user', timestamp: '2026-10-04T10:00:00Z', content: 'Remind me to order flour.' },
    { role: 'assistant', timestamp: '2026-10-04T10:00:02Z', content: 'I will remind you on Friday.' }] }) },
];

function homeWith(t) {
  const home = tempFolder(join(tmpdir(), 'conversations-rows-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const file of HOME) { mkdirSync(dirname(join(home, file.path)), { recursive: true }); writeFileSync(join(home, file.path), file.text); }
  return home;
}

// One run of a row as the engine starts it: its argv with this folder laid on /opt/conversations (and the workflows runner
// on /opt/workflows), its stdin with the input (the values handed in are its `stored`) and the granted folder.
function runRow(row, input, home, stored) {
  const argv = row.invoke.run.map(part => (typeof part === 'string' ? part.replace('/opt/workflows', join(folder, '..', 'workflows')).replace('/opt/conversations', folder) : part));
  const ran = spawnSync(argv[0], argv.slice(1), { input: JSON.stringify({ input: { ...input, stored }, folder: home }), encoding: 'utf8' });
  return JSON.parse(ran.stdout.trim().split('\n').at(-1));
}

// The caller's loop: a run that needs records, lists or files is answered from the store and run again; a complete run's
// writes are kept in the store. Returns the run's result.
function keptRow(row, input, home, store) {
  const answers = { records: new Map(), queries: new Map(), files: new Map() };
  for (let round = 0; round < 60; round += 1) {
    const stored = { records: [...answers.records.values()], queries: [...answers.queries.values()], files: Object.fromEntries(answers.files) };
    const answered = runRow(row, input, home, stored);
    assert.ok(!answered.error, answered.error);
    const { result } = answered;
    if (result.complete === false) {
      for (const need of result.needs.records) {
        const held = store.get(need.id);
        answers.records.set(need.id, { id: need.id, type: held?.type ?? need.type ?? null, value: held && (!need.type || held.type === need.type) ? held.value : null });
      }
      for (const query of result.needs.lists) answers.queries.set(JSON.stringify(query), { query, records: store.query(query) });
      for (const wanted of result.needs.files) answers.files.set(wanted, null);
      continue;
    }
    for (const item of result.keep ?? []) {
      if (item.file !== undefined) continue;
      if (item.value === null) store.rows.delete(item.id);
      else store.rows.set(item.id, { id: item.id, type: item.type, value: item.value });
    }
    const { keep: _keep, complete: _complete, ...shown } = result;
    return shown;
  }
  throw new Error('the row needed more than 60 rounds');
}

test('the list row finds the sources in the granted folder', async () => {
  const answer = await answerOf(rowOf(rows, 'tool:list-the-conversation-sources-on-this-computer'), {}, { files: HOME });
  assert.equal(answer.status, 0, JSON.stringify(answer));
  const found = Object.fromEntries(answer.result.sources.map(source => [source.source, source.files]));
  assert.deepEqual([found['grok-export'], found['hermes-sessions'], found['chatgpt-export']], [1, 1, 0]);
});

test('the import row keeps a source as values for the caller to keep, and the progress and count rows read them back', t => {
  const home = homeWith(t);
  const all = rows.records.map(record => record.payload);
  const store = heldStore();
  const imported = keptRow(all.find(row => row.id === 'tool:import-my-conversations-from-a-source'), { source: 'grok-export' }, home, store);
  assert.deepEqual([imported.done, imported.conversations_kept, imported.messages_added], [true, 1, 2]);
  const resumed = keptRow(all.find(row => row.id === 'tool:resume-importing-my-conversations'), {}, home, store);
  assert.deepEqual(resumed.sources.map(source => [source.source, source.messages_added]), [['grok-export', 0], ['hermes-sessions', 2]]);
  const progress = keptRow(all.find(row => row.id === 'tool:show-how-far-my-conversation-import-is'), {}, home, store);
  assert.deepEqual(progress.sources.map(source => [source.source, source.state, source.messages_added]), [['grok-export', 'done', 2], ['hermes-sessions', 'done', 2]]);
  const counted = keptRow(all.find(row => row.id === 'tool:count-my-ai-conversations-per-app'), {}, home, store);
  assert.deepEqual(counted, { conversations: 2, apps: [{ app: 'Grok', conversations: 1, messages: 2 }, { app: 'Hermes', conversations: 1, messages: 2 }] });
});

test('a row run that is not handed its records answers what it needs and keeps nothing', t => {
  const home = homeWith(t);
  const row = rows.records.map(record => record.payload).find(item => item.id === 'tool:show-how-far-my-conversation-import-is');
  const asked = runRow(row, {}, home, { records: [] }).result;
  assert.equal(asked.complete, false);
  assert.deepEqual(asked.keep, []);
  assert.ok(asked.needs.lists.length >= 1);
});
