// tools/conversations/test/import-rows.test.mjs
//
// The import rows run the way the engine runs them (test-helpers/run-a-row.mjs): the files they pack laid at their
// places, their argv through run-an-export.mjs, their stdin filled from their own template ({ input, folder }, the
// folder granted to their read-a-folder capability) and the stand-in records door on their descriptor with exactly
// their rights. A made-up Grok export and a Hermes session, laid in the granted folder, stand in for the person's files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));

// The person's files, laid in the folder the row's read-a-folder capability is granted.
const HOME = [
  { grant: 'read-a-folder', path: 'Downloads/grok/prod-grok-backend.json', text: JSON.stringify({ conversations: [{ conversation: { id: 'gk-1', title: 'Hydration' }, responses: [
    { response: { _id: 'gk-1-a', sender: 'human', message: 'What hydration for a country loaf?', create_time: { $date: { $numberLong: '1736000000000' } } } },
    { response: { _id: 'gk-1-b', sender: 'ASSISTANT', message: 'About 75 percent.', create_time: { $date: { $numberLong: '1736000003000' } } } }] }] }) },
  { grant: 'read-a-folder', path: '.hermes/sessions/session_1.json', text: JSON.stringify({ session_id: 'hermes-1', session_start: '2026-10-04T10:00:00Z', messages: [
    { role: 'user', timestamp: '2026-10-04T10:00:00Z', content: 'Remind me to order flour.' },
    { role: 'assistant', timestamp: '2026-10-04T10:00:02Z', content: 'I will remind you on Friday.' }] }) },
];

test('the list row finds the sources in the granted folder', async () => {
  const answer = await answerOf(rowOf(rows, 'tool:list-the-conversation-sources-on-this-computer'), {}, { files: HOME });
  assert.equal(answer.status, 0, JSON.stringify(answer));
  const found = Object.fromEntries(answer.result.sources.map(source => [source.source, source.files]));
  assert.deepEqual([found['grok-export'], found['hermes-sessions'], found['chatgpt-export']], [1, 1, 0]);
});

test('the import row keeps a source through the door, and the progress and count rows read it back', async () => {
  const imported = await answerOf(rowOf(rows, 'tool:import-my-conversations-from-a-source'), { source: 'grok-export' }, { files: HOME });
  assert.equal(imported.status, 0, JSON.stringify(imported));
  assert.deepEqual([imported.result.done, imported.result.conversations_kept, imported.result.messages_added], [true, 1, 2]);
  const resumed = await answerOf(rowOf(rows, 'tool:resume-importing-my-conversations'), {}, { files: HOME, records: imported.kept });
  assert.equal(resumed.status, 0, JSON.stringify(resumed));
  assert.deepEqual(resumed.result.sources.map(source => [source.source, source.messages_added]), [['grok-export', 0], ['hermes-sessions', 2]]);
  const progress = await answerOf(rowOf(rows, 'tool:show-how-far-my-conversation-import-is'), {}, { records: resumed.kept });
  assert.deepEqual(progress.result.sources.map(source => [source.source, source.state, source.messages_added]), [['grok-export', 'done', 2], ['hermes-sessions', 'done', 2]]);
  const counted = await answerOf(rowOf(rows, 'tool:count-my-ai-conversations-per-app'), {}, { records: resumed.kept });
  assert.deepEqual(counted.result, { conversations: 2, apps: [{ app: 'Grok', conversations: 1, messages: 2 }, { app: 'Hermes', conversations: 1, messages: 2 }] });
});
