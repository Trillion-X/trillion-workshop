// tools/conversations/test/native-chat-import.test.mjs (moved from Trillion-X/trillion test/native-chat-import.test.mjs)
//
// One chat's archive brought into an account whose records and files live in its own addressed owners. The old test
// reached the files through the Worker's Namespace routes (src/native-namespace-account-host.mjs, not moved); in the
// Workshop the account's own owners are reached through the run's records door, so the same made-up chat goes through
// importConversation over stagedRecords(door), its files found beside the export on this computer (or where the person
// said) and kept through the files door. The old assertions hold: file-Tile01 never finds file-Tile011, a file not
// there is reported, a repeat adds nothing twice (no message and no file written again), a name the person gave is
// read by that name, and with no folder searched none is walked.
// Every person, file and chat here is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { importConversationsFrom } from '../read-data/chat-import.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';

const RIGHTS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload)
  .find(row => row.id === 'tool:import-my-conversations-from-a-source').invoke.records.rights;
const NOW = new Date('2026-11-04T12:00:00Z');
const identityOf = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text));

const chat = { id: 'conv-kiln', title: 'Glaze test tiles', create_time: 1_790_000_000, current_node: 'n2', mapping: {
  root: { id: 'root', parent: null, message: null },
  n1: { id: 'n1', parent: 'root', message: { author: { role: 'user' }, create_time: 1_790_000_010, content: { content_type: 'multimodal_text', parts: [
    { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-Tile01' }, 'Why did this glaze crawl?'] },
    metadata: { attachments: [{ id: 'file-Tile01', name: 'tile.jpg', mime_type: 'image/jpeg' }] } } },
  n2: { id: 'n2', parent: 'n1', message: { author: { role: 'assistant' }, create_time: 1_790_000_020, content: { content_type: 'multimodal_text', parts: [
    { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_00000000aa11' }, 'Here is a thinner coat.'] } } },
} };

function homeWith(exportAt, files) {
  const home = mkdtempSync(join(tmpdir(), 'native-chat-import-'));
  const put = (path, text) => { mkdirSync(dirname(join(home, path)), { recursive: true }); writeFileSync(join(home, path), text); };
  put(exportAt, JSON.stringify([chat]));
  for (const [path, text] of Object.entries(files)) put(path, text);
  return { home, touch: () => { const later = new Date(Date.now() + 60_000); utimesSync(join(home, exportAt), later, later); } };
}
async function doorFor(t) {
  const fake = await startFakeDoor({ rights: RIGHTS });
  t.after(() => fake.close());
  return { fake, context: { door: openRecordsDoor({ descriptor: fake.descriptor, wait: async () => {} }), wait: async () => {}, now: () => NOW } };
}
const keptMessages = fake => [...fake.kept.values()].filter(record => record.type === 'message').map(record => record.value);

test('an export\'s files are found beside it, linked in their messages, and a repeat adds nothing twice', async t => {
  const { home, touch } = homeWith('Downloads/kiln/conversations.json', { 'Downloads/kiln/file-Tile01-tile.jpg': 'tile', 'Downloads/kiln/file-Tile011-other.jpg': 'other' });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { fake, context } = await doorFor(t);
  const run = () => importConversationsFrom({ input: { source: 'chatgpt-export' }, folder: home }, context);
  const first = await run();
  assert.deepEqual([first.done, first.messages_added, first.attachments_kept, first.attachments_not_kept], [true, 2, 1, 1]);
  const kept = keptMessages(fake);
  assert.deepEqual(kept.find(message => message.text === 'Why did this glaze crawl?').about, [{ kind: 'file', id: identityOf('tile') }], 'file-Tile01 never finds file-Tile011');
  assert.deepEqual([...fake.stored.keys()], ['/messages/ChatGPT/file-Tile01-tile.jpg']);
  const written = fake.calls.filter(call => call.method === 'write_file_finish').length;
  touch();
  const again = await run();
  assert.deepEqual([again.messages_added, again.messages_already_kept], [0, 2]);
  assert.equal(fake.calls.filter(call => call.method === 'write_file_finish').length, written, 'the file is not written again');
});

test('a name the person gave is read by that name, and with nothing beside the export no file is found there', async t => {
  const { home } = homeWith('Downloads/kiln/conversations.json', { 'Pictures/photo.png': 'given' });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { fake, context } = await doorFor(t);
  const result = await importConversationsFrom({ input: { source: 'chatgpt-export', attachments: { 'file-Tile01': 'Pictures/photo.png', 'file_00000000aa11': '../outside.png' } }, folder: home }, context);
  assert.deepEqual([result.attachments_kept, result.attachments_not_kept], [1, 1], 'a path that leaves the granted folder is a file not there, never an error');
  assert.deepEqual(keptMessages(fake).find(message => message.text === 'Why did this glaze crawl?').attachments, [{ identity: identityOf('given'), name: 'tile.jpg', media_type: 'image/jpeg' }]);
  assert.deepEqual([...fake.stored.keys()], ['/messages/ChatGPT/photo.png']);
});
