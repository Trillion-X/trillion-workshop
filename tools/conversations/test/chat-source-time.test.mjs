import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationFrom } from '../src/chat-archives.mjs';
import { messages, MAX_TEXT } from '../src/messages.mjs';
import { localStore } from '../src/local-store.mjs';

const sourceAt = '2024-07-22T08:05:10.299746Z';
const read = text => conversationFrom({ conversation_id: 'precision', messages: [
  { id: 'original-row', speaker: 'person', text, at: sourceAt },
] }, 'Example AI');

test('an imported source time retains its precision through split messages and replay', () => {
  const chat = read('x'.repeat(MAX_TEXT + 25));
  assert.ok(chat.messages.length > 1);
  assert.ok(chat.messages.every(message => message.source_at === sourceAt));
  const store = messages(localStore(':memory:').eeaf, { now: () => new Date('2026-10-12T00:00:00Z') });
  const rows = chat.messages.map(message => ({
    app: chat.app, conversation_id: chat.conversation_id, speaker: message.speaker,
    text: message.text, at: message.at, source_ref: message.node,
  }));
  const first = store.record({ messages: rows });
  const replay = store.record({ messages: rows.map(row => ({ ...row, source_at: sourceAt })) });
  assert.equal(replay.recorded, 0);
  assert.deepEqual(replay.ids, first.ids);
  const kept = store.read({ conversation_id: chat.conversation_id, limit: 100 }).messages;
  assert.equal(kept.length, rows.length);
  assert.ok(kept.every(message => message.source_at === sourceAt));
  assert.equal(store.record({ messages: rows.map(row => ({ ...row, source_at: sourceAt })) }).recorded, 0);
});

test('source times remain checked and require an original message reference', () => {
  const store = messages(localStore(':memory:').eeaf, { now: () => new Date('2026-10-12T00:00:00Z') });
  const row = { app: 'Example AI', conversation_id: 'precision', speaker: 'person', text: 'original', at: sourceAt };
  assert.throws(() => store.record({ messages: [{ ...row, source_at: sourceAt }] }), /source_ref/);
  assert.throws(() => store.record({ messages: [{ ...row, source_ref: 'row', source_at: '2040-01-01T00:00:00Z' }] }), /later than now/);
  assert.throws(() => store.record({ messages: [{ ...row, source_ref: 'row', source_at: 'invalid' }] }), /date and time/);
});
