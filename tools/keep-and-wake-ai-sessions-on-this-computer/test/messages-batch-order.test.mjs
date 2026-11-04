// A conversation sent in one record_messages call without times reads back in the order it was sent: each message is
// stamped one millisecond after the one before it. Before this, all four shared one time and the chat screen showed
// them in the order of their words' hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../src/local-store.mjs';
import { messages } from '../src/messages.mjs';

test('a batch without times keeps the order it was sent in, and a resend is still one message', () => {
  const kept = messages(localStore(':memory:').eeaf, { now: () => new Date('2026-09-30T08:00:00Z') });
  const said = ['Can you draft the sales page?', 'Yes. Do you want the price on it?', 'Yes, $400.', 'Done, it is in Files.'];
  const batch = { messages: said.map((text, index) => ({ conversation_id: 'c', app: 'ChatGPT', speaker: index % 2 ? 'ai' : 'person', text })) };
  assert.equal(kept.record(batch).recorded, 4);
  assert.deepEqual(kept.read({ conversation_id: 'c' }).messages.map(item => item.text), [...said].reverse(), 'newest first is the reverse of the order sent');
  assert.equal(kept.record(batch).recorded, 0, 'sending the same batch again keeps nothing new');
});
