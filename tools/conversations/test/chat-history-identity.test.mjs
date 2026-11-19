// tools/conversations/test/chat-history-identity.test.mjs (moved from Trillion-X/trillion test/chat-history-identity.test.mjs)
//
// Run the actual archive method with its storage dependencies: the person's records are the rows the run is handed
// (test/support/held-store.mjs plays the person's store), reached the way the import reaches them (ownerRecords over the
// rows in hand), instead of the Worker's store.
import assert from 'node:assert/strict';
import test from 'node:test';
import { importConversation, ownerRecords } from '../read-data/chat-import.mjs';
import { answering } from '../read-data/rows-in-hand.mjs';
import { heldStore, runKept } from './support/held-store.mjs';

// The account's importer as the import wires it (read-data/chat-import.mjs importOneSource).
function world() {
  const fake = heldStore();
  const namespace = { locate: id => id === '1f:' + 'a'.repeat(64) ? { identity: id, byte_length: 25, names: ['/history/original.png'], media_type: 'image/png' } : null };
  // The person's files are not searched by the run: the test's namespace stands in for the files the caller hands in.
  const importConversations = input => runKept(fake, (request, context) => answering(request, context, hand =>
    importConversation(input, { hand, eeaf: ownerRecords(hand), now: () => new Date('2026-10-12T00:00:00Z'),
      find: async ref => { const file = namespace.locate(ref.id); return file ? { identity: file.identity, name: file.names[0], byte_length: file.byte_length, media_type: file.media_type } : null; } })), {}).then(done => done.answer);
  const kept = conversationId => [...fake.kept.values()].filter(record => record.type === 'message' && record.value.conversation_id === conversationId).map(record => record.value);
  const rows = () => [...fake.kept.values()].filter(record => record.type === 'record:ai-conversation');
  return { fake, importConversations, kept, rows };
}
const keepFile = () => '1f:' + 'a'.repeat(64);


test('trusted history preserves its complete conversation identity, files and timestamps without opening work', async () => {
  const store = world();
  const file = keepFile(store, '/history/original.png', 'original attachment bytes');
  const conversation = { conversation_id: 'native-transcript:original-session', messages: [
    { id: 'person-native-id', speaker: 'person', text: 'An old request, preserved only as history.', at: '2026-06-01T10:00:00Z' },
    { id: 'ai-native-id', speaker: 'ai', text: 'Original reply.', at: '2026-06-01T10:01:00Z', metadata: { attachments: [{ id: file }] } },
    { id: 'photo-native-id', speaker: 'person', text: '', at: '2026-06-01T10:02:00Z', metadata: { attachments: [{ id: file }] } },
  ] };
  const input = { conversation, app: 'A transcript app', preserve_conversation_id: true };
  const first = await store.importConversations(input);
  assert.equal(first.conversation_id, conversation.conversation_id);
  assert.equal(first.added, 3);
  const kept = store.kept(conversation.conversation_id);
  assert.equal(kept.length, 3);
  assert.equal(kept.find(message => message.source_ref === 'person-native-id').at, '2026-06-01T10:00:00.000Z');
  assert.equal(kept.find(message => message.source_ref === 'photo-native-id').text, '');
  assert.equal(kept.find(message => message.source_ref === 'ai-native-id').attachments[0].identity, file);
  const row = () => store.rows().find(item => item.value.conversation_id === conversation.conversation_id);
  assert.deepEqual([row().value.messages, row().value.started, row().value.last], [3, '2026-06-01T10:00:00.000Z', '2026-06-01T10:02:00.000Z']);
  // The person sets a pursuit on the row; a re-import keeps it.
  const personal = row();
  store.fake.kept.set(personal.id, { ...personal, value: { ...personal.value, pursuits: ['A pursuit the person chose'] } });
  const again = await store.importConversations(input);
  assert.deepEqual([again.added, again.already_there], [0, 3]);
  assert.equal(store.rows().length, 1);
  assert.deepEqual(row().value.pursuits, ['A pursuit the person chose']);
  assert.equal([...store.fake.kept.values()].filter(record => record.type === 'message').length, 3);
});
