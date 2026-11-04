// Run the actual archive method with its storage dependencies, without bundling unrelated Worker classes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { localStore } from '../src/local-store.mjs';
import { messages } from '../src/messages.mjs';
import { importConversation } from '../src/chat-import.mjs';
import { makeLists } from '../src/lists.mjs';

// The account's importer as PersonStore wires it (src/person-store.mjs importConversations).
async function importConversations(input) {
  return importConversation(input, { eeaf: this.store.eeaf, namespace: this.namespace,
    addSpaceItems: () => assert.fail('history without a space adds no space items'), relay: () => assert.fail('history without a space needs no relay') });
}
const FULL = { private: true, spaces: 'all' };
function world() {
  return { person: () => ({ store: localStore(':memory:'), namespace: { locate: id => id === '1f:' + 'a'.repeat(64) ? { identity: id, byte_length: 25, names: ['/history/original.png'], media_type: 'image/png' } : null }, importConversations, takeMoment: () => assert.fail('history must not create live arrivals'), settleArrivals: () => assert.fail('history must not run current work') }) };
}
const keepFile = () => '1f:' + 'a'.repeat(64);


test('trusted history preserves its complete conversation identity, files and timestamps without opening work', async () => {
  const store = world().person('historical-reader');
  const file = keepFile(store, '/history/original.png', 'original attachment bytes');
  const conversation = { conversation_id: 'native-transcript:original-session', messages: [
    { id: 'person-native-id', speaker: 'person', text: 'An old request, preserved only as history.', at: '2026-06-01T10:00:00Z' },
    { id: 'ai-native-id', speaker: 'ai', text: 'Original reply.', at: '2026-06-01T10:01:00Z', metadata: { attachments: [{ id: file }] } },
    { id: 'photo-native-id', speaker: 'person', text: '', at: '2026-06-01T10:02:00Z', metadata: { attachments: [{ id: file }] } },
  ] };
  const input = { conversation, app: 'A transcript app', preserve_conversation_id: true, attachments: { [file]: file }, reach: FULL };
  const first = await store.importConversations(input);
  assert.equal(first.conversation_id, conversation.conversation_id);
  assert.equal(first.added, 3);
  const kept = messages(store.store.eeaf).read({ conversation_id: conversation.conversation_id, limit: 10 }).messages;
  assert.equal(kept.length, 3);
  assert.equal(kept.find(message => message.source_ref === 'person-native-id').at, '2026-06-01T10:00:00.000Z');
  assert.equal(kept.find(message => message.source_ref === 'photo-native-id').text, '');
  assert.equal(kept.find(message => message.source_ref === 'ai-native-id').attachments[0].identity, file);
  const lists = makeLists({ eeaf: store.store.eeaf });
  const row = () => lists.read('ai-conversations').rows.find(item => item.values.conversation_id === conversation.conversation_id);
  assert.deepEqual([row().values.messages, row().values.started, row().values.last], [3, '2026-06-01T10:00:00.000Z', '2026-06-01T10:02:00.000Z']);
  lists.putRows('ai-conversations', { rows: [{ id: row().id, values: { pursuits: ['A pursuit the person chose'] } }] });
  const again = await store.importConversations(input);
  assert.deepEqual([again.added, again.already_there], [0, 3]);
  assert.equal(lists.read('ai-conversations').rows.length, 1);
  assert.deepEqual(row().values.pursuits, ['A pursuit the person chose']);
  await assert.rejects(store.importConversations({ ...input, reach: { private: false, spaces: [] } }), /cannot keep messages in the private/);
  assert.equal(messages(store.store.eeaf).read({ limit: 10 }).messages.length, 3);
});
