// tools/conversations/test/chat-attachments.test.mjs (moved from Trillion-X/trillion test/chat-attachments.test.mjs)
//
// Chat imports carry their files (read-data/chat-archives.mjs attachmentsOf, read-data/chat-import.mjs attachmentFinder
// and the import over the records door). The old test ran the Worker's PersonStore and Network on SQLite; here the same
// made-up chat goes through the Workshop tool: the namespace finder over an in-memory namespace with the same files, and
// the on-computer import over the fake records door, where a file beside the export is copied through the files door.
// Its assertions are the old ones: a file is found by the id it starts with (never as the start of a longer id), under
// a folder below the export's, or at the name the person gave; a message of only files waits for its file; a file not
// found is reported, never an error; bringing the chat in again adds nothing twice but links a file added since; a
// message kept again gains only the links it did not have. The two space tests (a file item members read from the
// importer's store until withdrawn or the importer leaves) stay behind: the Worker's space owner did not move here.
// Every person, file and chat here is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { attachmentsOf, conversationFrom } from '../read-data/chat-archives.mjs';
import { attachmentFinder, importConversationsFrom, stagedRecords } from '../read-data/chat-import.mjs';
import { messages } from '../../keep-and-wake-ai-sessions-on-this-computer/src/messages.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';

const RIGHTS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload)
  .find(row => row.id === 'tool:import-my-conversations-from-a-source').invoke.records.rights;
const NOW = new Date('2026-11-04T12:00:00Z');
const identityOf = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text));

// One made-up chat: a photo sent with words, a photo sent alone, and an answer with a generated picture.
const chat = { id: 'conv-kiln', title: 'Glaze test tiles', create_time: 1_790_000_000, current_node: 'n4', mapping: {
  root: { id: 'root', parent: null, message: null },
  n1: { id: 'n1', parent: 'root', message: { author: { role: 'user' }, create_time: 1_790_000_010, content: { content_type: 'multimodal_text', parts: [
    { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-Tile01' }, 'Why did this glaze crawl?'] },
    metadata: { attachments: [{ id: 'file-Tile01', name: 'tile.jpg', mime_type: 'image/jpeg', size: 2048 }] } } },
  n2: { id: 'n2', parent: 'n1', message: { author: { role: 'assistant' }, create_time: 1_790_000_020, content: { parts: ['Too thick over dust.'] }, metadata: { model_slug: 'gpt-x' } } },
  n3: { id: 'n3', parent: 'n2', message: { author: { role: 'user' }, create_time: 1_790_000_030, content: { content_type: 'multimodal_text', parts: [
    { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_00000000aa11' }] } } },
  n4: { id: 'n4', parent: 'n3', message: { author: { role: 'assistant' }, create_time: 1_790_000_040, content: { content_type: 'multimodal_text', parts: [
    { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_00000000bb22' }, 'Here is a thinner coat.'] } } },
} };

// The person's files as attachmentFinder reads them (byName, locate, foldersUnder, namesStartingWith), in memory.
function namespaceOf(files) {
  const row = name => (files[name] ? { identity: identityOf(files[name].text), byte_length: files[name].text.length, media_type: files[name].media_type, names: [name] } : null);
  return {
    byName: async name => row(name),
    locate: async identity => { const name = Object.keys(files).find(each => identityOf(files[each].text) === identity); return name ? row(name) : null; },
    foldersUnder: async root => [...new Set(Object.keys(files).filter(name => name.startsWith(`${root}/`)).map(name => dirname(name)))].sort(),
    namesStartingWith: async (folder, stem) => Object.keys(files).filter(name => dirname(name) === folder && name.slice(folder.length + 1).startsWith(stem)).sort().map(name => ({ name, identity: identityOf(files[name].text) })),
  };
}

test('each message names the files it carried, once each, by bare id; a message of only files is kept for them', () => {
  assert.deepEqual(attachmentsOf(chat.mapping.n1.message), [{ id: 'file-Tile01', name: 'tile.jpg', mime_type: 'image/jpeg' }], 'the pointer and the metadata name one file');
  assert.deepEqual(attachmentsOf({ content: { parts: ['words only'] } }), []);
  const read = conversationFrom(chat);
  assert.deepEqual(read.messages.map(message => [message.text, message.attachments.map(ref => ref.id)]), [
    ['Why did this glaze crawl?', ['file-Tile01']], ['Too thick over dust.', []], ['', ['file_00000000aa11']], ['Here is a thinner coat.', ['file_00000000bb22']],
  ]);
});

test('a file is found by the id its name starts with, under the export folder, or by the name the person gave', async () => {
  const files = {
    '/exports/kiln/file-Tile01-tile.jpg': { text: 'tile bytes', media_type: 'image/png' },
    '/exports/kiln/file-Tile011-other.jpg': { text: 'a different file whose id only starts the same', media_type: 'image/png' },
    '/exports/kiln/generations/file_00000000bb22-coat.webp': { text: 'drawn bytes', media_type: 'image/webp' },
    '/elsewhere/photo.png': { text: 'given bytes', media_type: 'image/png' },
  };
  const namespace = namespaceOf(files);
  const [tile, drawn, given] = ['tile bytes', 'drawn bytes', 'given bytes'].map(identityOf);
  const find = attachmentFinder(namespace, { folder: '/exports/kiln/', attachments: { 'file-Given': '/elsewhere/photo.png', 'file-ById': given } });
  assert.equal((await find({ id: 'file-Tile01' })).identity, tile);
  assert.equal((await find({ id: 'file-Tile01' })).name, '/exports/kiln/file-Tile01-tile.jpg');
  assert.equal((await find({ id: 'file_00000000bb22' })).identity, drawn, 'a folder under the export folder is searched');
  assert.equal((await find({ id: 'file_00000000bb22' })).media_type, 'image/webp');
  assert.equal((await find({ id: 'file-Given' })).identity, given);
  assert.equal((await find({ id: 'file-ById' })).identity, given);
  assert.equal(await find({ id: 'file-Tile0' }), null, 'an id is matched whole, never as the start of a longer id');
  assert.equal(await find({ id: 'file_00000000aa11' }), null);
  assert.equal(await attachmentFinder(namespace, {})({ id: 'file-Tile01' }), null, 'with no folder and no names given nothing is searched');
});

// The on-computer import: the export in a folder of the granted home, its files beside it.
function homeWith(files) {
  const home = mkdtempSync(join(tmpdir(), 'chat-attachments-'));
  const put = (path, bytes) => { mkdirSync(dirname(join(home, path)), { recursive: true }); writeFileSync(join(home, path), bytes); };
  put('Downloads/kiln/conversations.json', JSON.stringify([chat]));
  for (const [path, text] of Object.entries(files)) put(path, text);
  return { home, put, touch: () => { const later = new Date(Date.now() + 60_000); utimesSync(join(home, 'Downloads/kiln/conversations.json'), later, later); } };
}
async function doorFor(t) {
  const fake = await startFakeDoor({ rights: RIGHTS });
  t.after(() => fake.close());
  return { fake, context: { door: openRecordsDoor({ descriptor: fake.descriptor, wait: async () => {} }), wait: async () => {}, now: () => NOW } };
}
const keptMessages = fake => [...fake.kept.values()].filter(record => record.type === 'message').map(record => record.value);

test('a private import links each found file in its message, reports the rest, and a second import links what was added since', async t => {
  const { home, put, touch } = homeWith({ 'Downloads/kiln/file-Tile01-tile.jpg': 'tile bytes', 'Downloads/kiln/file_00000000bb22-coat.webp': 'drawn bytes' });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { fake, context } = await doorFor(t);
  const [tile, drawn] = ['tile bytes', 'drawn bytes'].map(identityOf);
  const run = () => importConversationsFrom({ input: { source: 'chatgpt-export' }, folder: home }, context);
  const first = await run();
  assert.equal(first.messages_added, 3, 'the photo sent alone waits for its file');
  assert.equal(first.attachments_kept, 2);
  assert.equal(first.attachments_not_kept, 1, 'file_00000000aa11 is reported, never an error');
  const kept = keptMessages(fake);
  assert.deepEqual(kept.find(message => message.text === 'Why did this glaze crawl?').about, [{ kind: 'file', id: tile }]);
  assert.deepEqual(kept.find(message => message.text === 'Why did this glaze crawl?').attachments, [{ identity: tile, name: 'tile.jpg', media_type: 'image/jpeg' }]);
  assert.deepEqual(kept.find(message => message.text === 'Here is a thinner coat.').about, [{ kind: 'file', id: drawn }]);
  assert.deepEqual(kept.find(message => message.text === 'Here is a thinner coat.').attachments, [{ identity: drawn, name: 'file_00000000bb22-coat.webp', media_type: 'image/webp' }]);
  assert.equal(kept.find(message => message.text === 'Too thick over dust.').about, undefined);
  // The bytes are the person's own file now, at the name the export gave it.
  assert.equal(makeHashCodeHexFromBytes(fake.stored.get('/messages/ChatGPT/file-Tile01-tile.jpg')), tile);

  touch();
  const again = await run();
  assert.deepEqual([again.messages_added, again.messages_already_kept], [0, 3], 'importing again adds nothing twice');
  assert.equal(keptMessages(fake).length, 3);

  put('Downloads/kiln/file_00000000aa11-kiln.png', 'kiln bytes');
  touch();
  const later = await run();
  assert.deepEqual([later.messages_added, later.attachments_not_kept], [1, 0]);
  const alone = identityOf('kiln bytes');
  const photoAlone = keptMessages(fake).filter(message => message.about?.some(link => link.id === alone));
  assert.deepEqual(photoAlone.map(message => [message.text, message.about]), [['', [{ kind: 'file', id: alone }]]]);
  assert.equal(photoAlone[0].attachments[0].identity, alone, 'a file-only message stores its real file identity on attachments');
  assert.equal(keptMessages(fake).length, 4);
});

// The message owner over the fake door, the way the import runs it.
async function ownerOver(t) {
  const { fake, context } = await doorFor(t);
  const staged = stagedRecords(context.door, { rules: { write_rows: 100, write_bytes: 400000 } });
  const store = messages(staged.eeaf, { now: () => NOW });
  return { record: input => staged.commit(() => store.record(input)), kept: () => keptMessages(fake) };
}

test('a message kept again gains only links it did not have; its words and id never change', async t => {
  const kept = await ownerOver(t);
  const message = { conversation_id: 'c', app: 'ChatGPT', speaker: 'person', at: '2026-09-27T10:00:00Z', text: 'see this' };
  const [id] = (await kept.record({ messages: [message] })).ids;
  const again = await kept.record({ messages: [{ ...message, about: [{ kind: 'file', id: '1f:aa' }] }] });
  assert.deepEqual([again.recorded, again.already_kept, again.linked, again.ids[0]], [0, 1, 1, id]);
  assert.equal((await kept.record({ messages: [{ ...message, about: [{ kind: 'file', id: '1f:aa' }] }] })).linked, undefined, 'the same link twice changes nothing');
  assert.deepEqual(kept.kept()[0].about, [{ kind: 'file', id: '1f:aa' }]);
  await assert.rejects(kept.record({ messages: [{ ...message, text: '' }] }), /text is required/, 'empty text needs a file it is about');
});

test('message attachments are kept as actual files, merge on replay, and remain part of the original message id', async t => {
  const kept = await ownerOver(t);
  const message = { conversation_id: 'claude-code:session', app: 'Claude Code', speaker: 'person', at: '2026-09-27T10:00:00Z', text: 'What is this?', source_ref: 'row-image' };
  const identity = `1f:${'b'.repeat(64)}`;
  const [id] = (await kept.record({ messages: [message] })).ids;
  const linked = await kept.record({ messages: [{ ...message, attachments: [{ identity, name: 'tile.png', media_type: 'image/png' }] }] });
  assert.deepEqual([linked.recorded, linked.already_kept, linked.linked, linked.ids[0]], [0, 1, 1, id]);
  assert.deepEqual(kept.kept()[0].attachments, [{ identity, name: 'tile.png', media_type: 'image/png' }]);
  assert.equal((await kept.record({ messages: [{ ...message, attachments: [identity] }] })).linked, undefined, 'the same file is linked once');
  await assert.rejects(kept.record({ messages: [{ ...message, attachments: ['not-a-file'] }] }), /file identities/);
});
