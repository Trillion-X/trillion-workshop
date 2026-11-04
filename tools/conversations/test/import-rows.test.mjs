// tools/conversations/test/import-rows.test.mjs
//
// The import rows run the way the engine runs them (tools/records-door/test/run-row.mjs): their argv through
// run-an-export.mjs, their stdin ({ input, folder }, the folder the person granted) and the fake records door on their
// descriptor with exactly their rights. A made-up Grok export and a Hermes session stand in for the person's files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRow, rowOf } from '../../records-door/test/run-row.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));

function home(t) {
  const folder = mkdtempSync(join(tmpdir(), 'conversations-rows-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, 'Downloads/grok'), { recursive: true });
  writeFileSync(join(folder, 'Downloads/grok/prod-grok-backend.json'), JSON.stringify({ conversations: [{ conversation: { id: 'gk-1', title: 'Hydration' }, responses: [
    { response: { _id: 'gk-1-a', sender: 'human', message: 'What hydration for a country loaf?', create_time: { $date: { $numberLong: '1736000000000' } } } },
    { response: { _id: 'gk-1-b', sender: 'ASSISTANT', message: 'About 75 percent.', create_time: { $date: { $numberLong: '1736000003000' } } } }] }] }));
  mkdirSync(join(folder, '.hermes/sessions'), { recursive: true });
  writeFileSync(join(folder, '.hermes/sessions/session_1.json'), JSON.stringify({ session_id: 'hermes-1', session_start: '2026-10-04T10:00:00Z', messages: [
    { role: 'user', timestamp: '2026-10-04T10:00:00Z', content: 'Remind me to order flour.' },
    { role: 'assistant', timestamp: '2026-10-04T10:00:02Z', content: 'I will remind you on Friday.' }] }));
  return folder;
}

test('the list row finds the sources in the granted folder', async t => {
  const folder = home(t);
  const answer = await runRow(rowOf(rows, 'tool:list-the-conversation-sources-on-this-computer'), { input: {}, folder });
  assert.equal(answer.status, 0, JSON.stringify(answer));
  const found = Object.fromEntries(answer.result.sources.map(source => [source.source, source.files]));
  assert.deepEqual([found['grok-export'], found['hermes-sessions'], found['chatgpt-export']], [1, 1, 0]);
});

test('the import row keeps a source through the door, and the progress and count rows read it back', async t => {
  const folder = home(t);
  const imported = await runRow(rowOf(rows, 'tool:import-my-conversations-from-a-source'), { input: { source: 'grok-export' }, folder });
  assert.equal(imported.status, 0, JSON.stringify(imported));
  assert.deepEqual([imported.result.done, imported.result.conversations_kept, imported.result.messages_added], [true, 1, 2]);
  const resumed = await runRow(rowOf(rows, 'tool:resume-importing-my-conversations'), { input: {}, folder }, { records: imported.kept });
  assert.equal(resumed.status, 0, JSON.stringify(resumed));
  assert.deepEqual(resumed.result.sources.map(source => [source.source, source.messages_added]), [['grok-export', 0], ['hermes-sessions', 2]]);
  const progress = await runRow(rowOf(rows, 'tool:show-how-far-my-conversation-import-is'), { input: {} }, { records: resumed.kept });
  assert.deepEqual(progress.result.sources.map(source => [source.source, source.state, source.messages_added]), [['grok-export', 'done', 2], ['hermes-sessions', 'done', 2]]);
  const counted = await runRow(rowOf(rows, 'tool:count-my-ai-conversations-per-app'), { input: {} }, { records: resumed.kept });
  assert.deepEqual(counted.result, { conversations: 2, apps: [{ app: 'Grok', conversations: 1, messages: 2 }, { app: 'Hermes', conversations: 1, messages: 2 }] });
});
