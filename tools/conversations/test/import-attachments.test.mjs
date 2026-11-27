// tools/conversations/test/import-attachments.test.mjs
//
// The files messages carried, copied into the person's files (read-data/chat-import.mjs
// fileKeeper, exportFilesBeside), with the person's files held by the test (test/support/held-store.mjs), over a made-up
// home: a ChatGPT export with its file-XXXX files beside it (one in a folder under it, one never there, a decoy whose id
// only starts the same), a Grok export with its assets at prod-mc-asset-server/<id>/content, and a Claude Code session
// with an image pasted into it. It checks where each file is kept and under which name, that a message names its files
// by identity, that a message of only files is kept once its file is, that a rerun copies nothing again, and that a
// run not handed a file it looks for asks for it and writes nothing.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { heldStore, runKept } from './support/held-store.mjs';
import * as chat from '../read-data/chat-import.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { exportFilesBeside, mediaTypeOf } from '../read-data/chat-import.mjs';

const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const NOW = new Date('2026-11-04T12:00:00Z');

// Bytes that start the way their kind does, and are long enough to take several pieces of a file (40 KiB each).
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(100_000, 7)]);
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(2_000, 3)]);
const PDF = Buffer.from('%PDF-1.4 a bakery price list');

function put(home, path, bytes) { mkdirSync(dirname(join(home, path)), { recursive: true }); writeFileSync(join(home, path), bytes); }
const lines = list => list.map(row => JSON.stringify(row) + '\n').join('');

function makeHome() {
  const home = tempFolder(join(tmpdir(), 'conversations-files-'));
  const node = (id, parent, role, parts, extra = {}, time = 1735700000) => [id, { id, parent, message: { author: { role }, create_time: time, content: { content_type: 'multimodal_text', parts }, metadata: extra } }];
  put(home, 'Downloads/chatgpt/conversations.json', JSON.stringify([{
    id: 'cg-f', title: 'A photo of the crumb', create_time: 1735700000, current_node: 'f-4',
    mapping: Object.fromEntries([
      node('f-1', null, 'user', ['What is wrong with this crumb?', { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-AB12' }], { attachments: [{ id: 'file-AB12', name: 'crumb.png', mime_type: 'image/png' }] }),
      node('f-2', 'f-1', 'assistant', ['It is under-proofed.'], { model_slug: 'gpt-4o' }, 1735700010),
      // A message of only a file: kept once its file is.
      node('f-3', 'f-2', 'user', [], { attachments: [{ id: 'file-CD34', name: 'prices.pdf' }] }, 1735700020),
      // A file never exported: counted, never an error.
      node('f-4', 'f-3', 'user', ['And this one?'], { attachments: [{ id: 'file-GONE', name: 'lost.jpg' }] }, 1735700030),
    ]),
  }]));
  put(home, 'Downloads/chatgpt/file-AB12-crumb.png', PNG);
  put(home, 'Downloads/chatgpt/file-AB123-other.png', JPEG); // starts with file-AB12 but is another id
  put(home, 'Downloads/chatgpt/user-xyz/file-CD34-prices.pdf', PDF);
  put(home, 'Downloads/grok/prod-grok-backend.json', JSON.stringify({ conversations: [{ conversation: { id: 'gk-f', title: 'A loaf picture' }, responses: [
    { response: { _id: 'gk-f-a', sender: 'human', message: 'Rate my loaf.', file_attachments: ['5e1f0a2b-asset'], create_time: { $date: { $numberLong: '1736000000000' } } } },
    { response: { _id: 'gk-f-b', sender: 'ASSISTANT', message: 'Nine of ten.', create_time: { $date: { $numberLong: '1736000004000' } }, model: 'grok-3' } }] }] }));
  put(home, 'Downloads/grok/prod-mc-asset-server/5e1f0a2b-asset/content', JPEG);
  const session = '99999999-2222-3333-4444-555555555555';
  put(home, `.claude/projects/-bakery/${session}.jsonl`, lines([
    { type: 'user', sessionId: session, uuid: 'cc-img', timestamp: '2026-10-01T10:00:00Z', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: [
      { type: 'text', text: 'Make the hero image look like this.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] } },
    { type: 'assistant', sessionId: session, uuid: 'cc-ok', timestamp: '2026-10-01T10:00:30Z', message: { role: 'assistant', model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } },
  ]));
  return { home, session };
}

// The person's store, played by the test: each run is handed what it asks for and its writes are kept there.
const keptRun = (store, fn, request) => runKept(store, fn, request, { now: () => NOW }).then(done => { const { keep: _keep, complete: _complete, ...answer } = done.answer ?? {}; return answer; });
const importConversationsFrom = (request, store) => keptRun(store, chat.importConversationsFrom, request);
const resumeConversationImports = (request, store) => keptRun(store, chat.resumeConversationImports, request);
const ofType = (fake, type) => [...fake.kept.values()].filter(record => record.type === type).map(record => record.value);
const request = (home, input) => ({ input, folder: home });
const id = bytes => makeHashCodeHexFromBytes(bytes);
const SOURCES = ['chatgpt-export', 'grok-export', 'claude-code-sessions'];

test('the files each source\'s messages carried are kept as the person\'s files, named the way old Trillion named them', async t => {
  const { home, session } = makeHome();
  const fake = heldStore();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const results = {};
  for (const source of SOURCES) results[source] = await importConversationsFrom(request(home, { source }), fake);
  assert.deepEqual(Object.fromEntries(Object.entries(results).map(([source, result]) => [source, [result.done, result.attachments_kept, result.attachments_not_kept, result.messages_added]])), {
    'chatgpt-export': [true, 2, 1, 4], 'grok-export': [true, 1, 0, 2], 'claude-code-sessions': [true, 1, 0, 2],
  });
  const kept = Object.fromEntries([...fake.files].map(([name, bytes]) => [name, id(bytes)]));
  assert.deepEqual(kept, {
    '/messages/ChatGPT/file-AB12-crumb.png': id(PNG),
    '/messages/ChatGPT/file-CD34-prices.pdf': id(PDF),
    '/messages/Grok/5e1f0a2b-asset.jpg': id(JPEG),
    [`/messages/claude-code_${session}/cc-img-1.png`]: id(PNG),
  });
  // The decoy that only starts with the same id is never taken; the file never exported is reported where it was asked.
  assert.ok(![...fake.files.keys()].some(name => name.includes('AB123')));
  const messages = ofType(fake, 'message');
  const crumb = messages.find(message => message.source_ref === 'f-1');
  assert.deepEqual(crumb.attachments, [{ identity: id(PNG), name: 'crumb.png', media_type: 'image/png' }]);
  assert.deepEqual(crumb.about, [{ kind: 'file', id: id(PNG) }]);
  const onlyFile = messages.find(message => message.source_ref === 'f-3');
  assert.equal(onlyFile.text, '');
  assert.deepEqual(onlyFile.attachments, [{ identity: id(PDF), name: 'prices.pdf', media_type: 'application/pdf' }]);
  assert.equal(messages.find(message => message.source_ref === 'f-4').attachments, undefined);
  assert.deepEqual(messages.find(message => message.source_ref === 'gk-f-a').attachments.map(file => file.identity), [id(JPEG)]);
  const pasted = messages.find(message => message.source_ref === 'cc-img');
  assert.equal(pasted.text, 'Make the hero image look like this.');
  assert.deepEqual(pasted.attachments.map(file => [file.identity, file.media_type]), [[id(PNG), 'image/png']]);
  // The cursor rows count what was copied and what was not.
  const cursor = ofType(fake, 'conversation-import-cursor').find(value => value.file === 'Downloads/chatgpt/conversations.json');
  assert.deepEqual([cursor.attachments_kept, cursor.attachments_not_kept], [2, 1]);

  // A rerun of every source (each file changed, so read again) writes no file again and keeps no message twice.
  const filesBefore = new Map(fake.files);
  for (const source of SOURCES) for (const file of results[source].files) put(home, file.file, readFileSync(join(home, file.file)));
  const again = await resumeConversationImports(request(home, { sources: SOURCES }), fake);
  assert.equal(again.more, false);
  assert.deepEqual([...fake.files.keys()].sort(), [...filesBefore.keys()].sort(), 'no file is copied again');
  for (const [name, bytes] of filesBefore) assert.ok(bytes.equals(fake.files.get(name)));
  assert.equal(ofType(fake, 'message').length, messages.length);
});

// A run is not handed the file it looks for: it asks for it by name, writes nothing, and the same run with the file
// given keeps the file and its messages once.
test('a run that is not handed a file it looks for asks for it, writes nothing, and keeps each file once when given', async t => {
  const { home } = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const asked = await chat.importConversationsFrom(request(home, { source: 'chatgpt-export' }), { now: () => NOW });
  assert.equal(asked.complete, false);
  assert.deepEqual(asked.keep, []);
  assert.ok(asked.needs.files.includes('/messages/ChatGPT/file-AB12-crumb.png'), JSON.stringify(asked.needs.files));
  const fake = heldStore();
  const done = await runKept(fake, (input, context) => chat.importConversationsFrom(input, { ...context, now: () => NOW }), request(home, { source: 'chatgpt-export' }));
  assert.ok(done.rounds >= 2);
  assert.equal(done.answer.attachments_kept, 2);
  assert.equal([...fake.files.keys()].filter(name => name.startsWith('/messages/ChatGPT/')).length, 2);
});

test('an export\'s files are found by the id their name starts with or the folder they sit in, never past the granted folder', t => {
  const { home } = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const beside = exportFilesBeside(home, join(home, 'Downloads/chatgpt/conversations.json'));
  assert.equal(beside.locate('file-AB12').name, 'file-AB12-crumb.png');
  assert.equal(beside.locate('file-AB123').name, 'file-AB123-other.png');
  assert.equal(beside.locate('file-CD34').name, 'file-CD34-prices.pdf');
  assert.equal(beside.locate('file-AB'), null);
  assert.equal(beside.locate('file-GONE'), null);
  assert.equal(beside.locate(''), null);
  const grok = exportFilesBeside(home, join(home, 'Downloads/grok/prod-grok-backend.json'));
  assert.equal(grok.locate('5e1f0a2b-asset').name, 'content');
  assert.equal(mediaTypeOf('content', JPEG), 'image/jpeg');
  assert.equal(mediaTypeOf('content', PNG), 'image/png');
  assert.equal(mediaTypeOf('notes.pdf', Buffer.alloc(0)), 'application/pdf');
  assert.equal(mediaTypeOf('content', Buffer.from('plain')), 'application/octet-stream');
});

test('a granted folder may use a symlink while an export or attachment outside it stays unread', t => {
  const { home } = makeHome();
  const aliases = tempFolder(join(tmpdir(), 'conversations-granted-'));
  const outside = tempFolder(join(tmpdir(), 'conversations-outside-'));
  t.after(() => { for (const folder of [home, aliases, outside]) rmSync(folder, { recursive: true, force: true }); });
  const granted = join(aliases, 'home');
  symlinkSync(home, granted);
  const beside = exportFilesBeside(granted, join(granted, 'Downloads/chatgpt/conversations.json'));
  assert.equal(beside.locate('file-AB12').name, 'file-AB12-crumb.png');

  put(outside, 'conversations.json', '[]');
  put(outside, 'file-ESC-private.png', PNG);
  assert.equal(exportFilesBeside(home, join(outside, 'conversations.json')).locate('file-ESC'), null);
  symlinkSync(outside, join(home, 'Downloads/chatgpt/outside'));
  assert.equal(exportFilesBeside(home, join(home, 'Downloads/chatgpt/outside/conversations.json')).locate('file-ESC'), null);
  assert.equal(exportFilesBeside(home, join(home, 'Downloads/chatgpt/conversations.json')).locate('file-ESC'), null);
});
