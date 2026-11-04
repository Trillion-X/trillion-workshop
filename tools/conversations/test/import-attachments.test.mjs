// tools/conversations/test/import-attachments.test.mjs
//
// The files messages carried, copied into the person's files through the files door (read-data/chat-import.mjs
// fileKeeper, exportFilesBeside), against the fake records door with exactly the import rows' rights, over a made-up
// home: a ChatGPT export with its file-XXXX files beside it (one in a folder under it, one never there, a decoy whose id
// only starts the same), a Grok export with its assets at prod-mc-asset-server/<id>/content, and a Claude Code session
// with an image pasted into it. It checks where each file is kept and under which name, that a message names its files
// by identity, that a message of only files is kept once its file is, that a rerun copies nothing again, and that a
// door that answers 503 in the middle of a file's pieces stops the run and a resume keeps each file once, whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { exportFilesBeside, importConversationsFrom, mediaTypeOf, resumeConversationImports } from '../read-data/chat-import.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const RIGHTS = rows.find(row => row.id === 'tool:import-my-conversations-from-a-source').invoke.records.rights;
const NOW = new Date('2026-11-04T12:00:00Z');

// Bytes that start the way their kind does, and are long enough to take several door pieces (40 KiB each).
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(100_000, 7)]);
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(2_000, 3)]);
const PDF = Buffer.from('%PDF-1.4 a bakery price list');

function put(home, path, bytes) { mkdirSync(dirname(join(home, path)), { recursive: true }); writeFileSync(join(home, path), bytes); }
const lines = list => list.map(row => JSON.stringify(row) + '\n').join('');

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'conversations-files-'));
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

async function doorFor() {
  const fake = await startFakeDoor({ rights: RIGHTS });
  // piecesBeforeBusy: that many file pieces land, then every piece is answered 503 while busy is true.
  const trouble = { piecesBeforeBusy: Infinity, pieces: 0, busy: false };
  const fetchImpl = async (url, init) => {
    if (String(init.body).includes('"write_file_piece"')) {
      trouble.pieces += 1;
      if (trouble.busy && trouble.pieces > trouble.piecesBeforeBusy) return new Response('', { status: 503 });
    }
    return fetch(url, init);
  };
  const door = openRecordsDoor({ descriptor: fake.descriptor, fetchImpl, wait: async () => {} });
  return { fake, trouble, context: { door, wait: async () => {}, now: () => NOW } };
}
const ofType = (fake, type) => [...fake.kept.values()].filter(record => record.type === type).map(record => record.value);
const request = (home, input) => ({ input, folder: home });
const id = bytes => makeHashCodeHexFromBytes(bytes);
const SOURCES = ['chatgpt-export', 'grok-export', 'claude-code-sessions'];

test('the files each source\'s messages carried are copied through the files door, named the way old Trillion named them', async t => {
  const { home, session } = makeHome();
  const { fake, context } = await doorFor();
  t.after(async () => { rmSync(home, { recursive: true, force: true }); await fake.close(); });
  const results = {};
  for (const source of SOURCES) results[source] = await importConversationsFrom(request(home, { source }), context);
  assert.deepEqual(Object.fromEntries(Object.entries(results).map(([source, result]) => [source, [result.done, result.attachments_kept, result.attachments_not_kept, result.messages_added]])), {
    'chatgpt-export': [true, 2, 1, 4], 'grok-export': [true, 1, 0, 2], 'claude-code-sessions': [true, 1, 0, 2],
  });
  const kept = Object.fromEntries([...fake.stored].map(([name, bytes]) => [name, id(bytes)]));
  assert.deepEqual(kept, {
    '/messages/ChatGPT/file-AB12-crumb.png': id(PNG),
    '/messages/ChatGPT/file-CD34-prices.pdf': id(PDF),
    '/messages/Grok/5e1f0a2b-asset.jpg': id(JPEG),
    [`/messages/claude-code_${session}/cc-img-1.png`]: id(PNG),
  });
  // The decoy that only starts with the same id is never taken; the file never exported is reported where it was asked.
  assert.ok(![...fake.stored.keys()].some(name => name.includes('AB123')));
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
  const writesBefore = fake.calls.filter(call => call.method === 'write_file_start').length;
  for (const source of SOURCES) for (const file of results[source].files) put(home, file.file, readFileSync(join(home, file.file)));
  const again = await resumeConversationImports(request(home, { sources: SOURCES }), context);
  assert.equal(again.more, false);
  assert.equal(fake.calls.filter(call => call.method === 'write_file_start').length, writesBefore);
  assert.equal(ofType(fake, 'message').length, messages.length);
});

test('a door that answers 503 in the middle of a file\'s pieces stops the run, and a resume keeps every file once and whole', async t => {
  const { home } = makeHome();
  const { fake, context, trouble } = await doorFor();
  t.after(async () => { rmSync(home, { recursive: true, force: true }); await fake.close(); });
  // The first piece of the first file lands; every piece after it is answered 503 past the run's retries.
  Object.assign(trouble, { piecesBeforeBusy: 1, busy: true });
  const first = await resumeConversationImports(request(home, { sources: SOURCES }), context);
  assert.equal(first.more, true);
  assert.match(first.sources.find(source => source.stopped).stopped, /stayed busy or slow/);
  assert.equal(ofType(fake, 'message').length, 0, 'nothing is kept before its files are');
  assert.equal(fake.calls.filter(call => call.method === 'write_file_piece').length, 1, 'one piece landed before the door went busy');
  assert.equal([...fake.stored.keys()].length, 0, 'a file is not kept until its last piece is');

  trouble.busy = false;
  const resumed = await resumeConversationImports(request(home, { sources: SOURCES }), context);
  assert.equal(resumed.more, false, JSON.stringify(resumed));
  assert.equal([...fake.stored.keys()].length, 4);
  assert.ok([...fake.stored.values()].every(bytes => [id(PNG), id(JPEG), id(PDF)].includes(id(bytes))));
  assert.equal(ofType(fake, 'message').length, 8);
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
