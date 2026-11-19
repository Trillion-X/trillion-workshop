// tools/conversations/test/chat-source-time.test.mjs (moved from Trillion-X/trillion test/chat-source-time.test.mjs)
//
// The message owner runs the way the import runs it (stagedRecords over the run's held door), with the person's store
// played by the test (test/support/held-store.mjs): a run is handed what it asks for, and what it writes is kept there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationFrom } from '../read-data/chat-archives.mjs';
import { messages, MAX_TEXT } from '../../keep-and-wake-ai-sessions-on-this-computer/src/messages.mjs';
import { stagedRecords } from '../read-data/chat-import.mjs';
import { heldStore, runKept } from './support/held-store.mjs';

function localStore() {
  const store = heldStore();
  const record = input => runKept(store, (_request, context) => {
    const staged = stagedRecords(context.door, { rules: { write_rows: 100, write_bytes: 400000 } });
    return staged.commit(() => messages(staged.eeaf, { now: () => new Date('2026-10-12T00:00:00Z') }).record(input));
  }, {}).then(done => done.answer);
  const kept = conversationId => [...store.rows.values()].filter(record => record.type === 'message' && record.value.conversation_id === conversationId).map(record => record.value);
  return { record, kept };
}

const sourceAt = '2024-07-22T08:05:10.299746Z';
const read = text => conversationFrom({ conversation_id: 'precision', messages: [
  { id: 'original-row', speaker: 'person', text, at: sourceAt },
] }, 'Example AI');

test('an imported source time retains its precision through split messages and replay', async () => {
  const chat = read('x'.repeat(MAX_TEXT + 25));
  assert.ok(chat.messages.length > 1);
  assert.ok(chat.messages.every(message => message.source_at === sourceAt));
  const store = localStore();
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

test('source times remain checked and require an original message reference', async () => {
  const store = localStore();
  const row = { app: 'Example AI', conversation_id: 'precision', speaker: 'person', text: 'original', at: sourceAt };
  await assert.rejects(store.record({ messages: [{ ...row, source_at: sourceAt }] }), /source_ref/);
  await assert.rejects(store.record({ messages: [{ ...row, source_ref: 'row', source_at: '2040-01-01T00:00:00Z' }] }), /later than now/);
  await assert.rejects(store.record({ messages: [{ ...row, source_ref: 'row', source_at: 'invalid' }] }), /date and time/);
});
