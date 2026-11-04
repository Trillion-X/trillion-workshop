// tools/conversations/test/chat-source-time.test.mjs (moved from Trillion-X/trillion test/chat-source-time.test.mjs)
//
// The message owner runs over the fake records door the way the import runs it (stagedRecords), instead of the Worker's store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conversationFrom } from '../read-data/chat-archives.mjs';
import { messages, MAX_TEXT } from '../../keep-and-wake-ai-sessions-on-this-computer/src/messages.mjs';
import { stagedRecords } from '../read-data/chat-import.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';

const RIGHTS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload)
  .find(row => row.id === 'tool:import-my-conversations-from-a-source').invoke.records.rights;
async function localStore(t) {
  const fake = await startFakeDoor({ rights: RIGHTS });
  t.after(() => fake.close());
  const staged = stagedRecords(openRecordsDoor({ descriptor: fake.descriptor, wait: async () => {} }), { rules: { write_rows: 100, write_bytes: 400000 } });
  const store = messages(staged.eeaf, { now: () => new Date('2026-10-12T00:00:00Z') });
  return { record: input => staged.commit(() => store.record(input)), kept: conversationId => [...fake.kept.values()].filter(record => record.type === 'message' && record.value.conversation_id === conversationId).map(record => record.value) };
}

const sourceAt = '2024-07-22T08:05:10.299746Z';
const read = text => conversationFrom({ conversation_id: 'precision', messages: [
  { id: 'original-row', speaker: 'person', text, at: sourceAt },
] }, 'Example AI');

test('an imported source time retains its precision through split messages and replay', async t => {
  const chat = read('x'.repeat(MAX_TEXT + 25));
  assert.ok(chat.messages.length > 1);
  assert.ok(chat.messages.every(message => message.source_at === sourceAt));
  const store = await localStore(t);
  const rows = chat.messages.map(message => ({
    app: chat.app, conversation_id: chat.conversation_id, speaker: message.speaker,
    text: message.text, at: message.at, source_ref: message.node,
  }));
  const first = await store.record({ messages: rows });
  const replay = await store.record({ messages: rows.map(row => ({ ...row, source_at: sourceAt })) });
  assert.equal(replay.recorded, 0);
  assert.deepEqual(replay.ids, first.ids);
  const kept = store.kept(chat.conversation_id);
  assert.equal(kept.length, rows.length);
  assert.ok(kept.every(message => message.source_at === sourceAt));
  assert.equal((await store.record({ messages: rows.map(row => ({ ...row, source_at: sourceAt })) })).recorded, 0);
});

test('source times remain checked and require an original message reference', async t => {
  const store = await localStore(t);
  const row = { app: 'Example AI', conversation_id: 'precision', speaker: 'person', text: 'original', at: sourceAt };
  await assert.rejects(store.record({ messages: [{ ...row, source_at: sourceAt }] }), /source_ref/);
  await assert.rejects(store.record({ messages: [{ ...row, source_ref: 'row', source_at: '2040-01-01T00:00:00Z' }] }), /later than now/);
  await assert.rejects(store.record({ messages: [{ ...row, source_ref: 'row', source_at: 'invalid' }] }), /date and time/);
});
