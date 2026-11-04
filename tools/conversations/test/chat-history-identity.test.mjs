// tools/conversations/test/chat-history-identity.test.mjs (moved from Trillion-X/trillion test/chat-history-identity.test.mjs)
//
// Run the actual archive method with its storage dependencies: the person's records are the fake records door with the
// import rows' rights, reached the way the import reaches them (stagedRecords, listsOverDoor), instead of the Worker's store.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { listsOverDoor } from '../../records-door/read-data/lists-door.mjs';
import { importConversation, stagedRecords } from '../read-data/chat-import.mjs';

const RIGHTS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload)
  .find(row => row.id === 'tool:import-my-conversations-from-a-source').invoke.records.rights;

// The account's importer as the import wires it (read-data/chat-import.mjs importOneSource).
async function world(t) {
  const fake = await startFakeDoor({ rights: RIGHTS });
  t.after(() => fake.close());
  const door = openRecordsDoor({ descriptor: fake.descriptor, wait: async () => {} });
  const staged = stagedRecords(door);
  const lists = listsOverDoor(door);
  const namespace = { locate: id => id === '1f:' + 'a'.repeat(64) ? { identity: id, byte_length: 25, names: ['/history/original.png'], media_type: 'image/png' } : null };
  const importConversations = input => importConversation(input, { eeaf: staged.eeaf, commit: step => staged.commit(step), lists, namespace, now: () => new Date('2026-10-12T00:00:00Z'),
    addSpaceItems: () => assert.fail('history without a space adds no space items'), relay: () => assert.fail('history without a space needs no relay') });
  const kept = conversationId => [...fake.kept.values()].filter(record => record.type === 'message' && record.value.conversation_id === conversationId).map(record => record.value);
  const rows = () => [...fake.kept.values()].filter(record => record.type === 'record:ai-conversation');
  return { fake, lists, importConversations, kept, rows };
}
const FULL = { private: true, spaces: 'all' };
const keepFile = () => '1f:' + 'a'.repeat(64);


test('trusted history preserves its complete conversation identity, files and timestamps without opening work', async t => {
  const store = await world(t);
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
  const kept = store.kept(conversation.conversation_id);
  assert.equal(kept.length, 3);
  assert.equal(kept.find(message => message.source_ref === 'person-native-id').at, '2026-06-01T10:00:00.000Z');
  assert.equal(kept.find(message => message.source_ref === 'photo-native-id').text, '');
  assert.equal(kept.find(message => message.source_ref === 'ai-native-id').attachments[0].identity, file);
  const row = () => store.rows().find(item => item.value.conversation_id === conversation.conversation_id);
  assert.deepEqual([row().value.messages, row().value.started, row().value.last], [3, '2026-06-01T10:00:00.000Z', '2026-06-01T10:02:00.000Z']);
  await store.lists.putRows('ai-conversations', { rows: [{ id: row().id.slice('record:ai-conversation:'.length), values: { pursuits: ['A pursuit the person chose'] } }] });
  const again = await store.importConversations(input);
  assert.deepEqual([again.added, again.already_there], [0, 3]);
  assert.equal(store.rows().length, 1);
  assert.deepEqual(row().value.pursuits, ['A pursuit the person chose']);
  await assert.rejects(store.importConversations({ ...input, reach: { private: false, spaces: [] } }), /cannot keep messages in the private/);
  assert.equal([...store.fake.kept.values()].filter(record => record.type === 'message').length, 3);
});
