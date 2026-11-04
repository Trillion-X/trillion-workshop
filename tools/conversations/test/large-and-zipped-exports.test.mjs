// tools/conversations/test/large-and-zipped-exports.test.mjs
//
// What #155 left undone, over the fake records door with the import rows' rights and a made-up home (a bakery's chats):
// a ChatGPT conversations.json read one conversation at a time (read-data/json-array-stream.mjs), its cursor keeping
// the byte the next conversation starts after so a stopped run starts there; a zipped ChatGPT export whose files are
// found and copied from inside the zip; and a Grok message of only an image, with no words, kept with its file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zipSync } from 'fflate';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { exportFilesInZip, importConversationsFrom } from '../read-data/chat-import.mjs';
import { NotAJsonArray, firstByteOf, jsonArrayElements } from '../read-data/json-array-stream.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const RIGHTS = rows.find(row => row.id === 'tool:import-my-conversations-from-a-source').invoke.records.rights;
const NOW = new Date('2026-11-04T12:00:00Z');
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(5_000, 7)]);
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(2_000, 3)]);
const id = bytes => makeHashCodeHexFromBytes(bytes);

function put(home, path, bytes) { mkdirSync(dirname(join(home, path)), { recursive: true }); writeFileSync(join(home, path), bytes); }
const home = t => { const path = mkdtempSync(join(tmpdir(), 'conversations-large-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };

async function doorFor(t) {
  const fake = await startFakeDoor({ rights: RIGHTS });
  const trouble = { busyFrom: Infinity, busyCalls: 0, calls: 0 };
  const fetchImpl = async (url, init) => {
    trouble.calls += 1;
    if (trouble.calls >= trouble.busyFrom && trouble.busyCalls > 0) { trouble.busyCalls -= 1; return new Response('', { status: 503 }); }
    return fetch(url, init);
  };
  const door = openRecordsDoor({ descriptor: fake.descriptor, fetchImpl, wait: async () => {} });
  t.after(() => fake.close());
  return { fake, trouble, context: { door, wait: async () => {}, now: () => NOW } };
}
const ofType = (fake, type) => [...fake.kept.values()].filter(record => record.type === type).map(record => record.value);

// One ChatGPT conversation tree: a question and an answer, with words that hold the bytes the reader looks at.
const chat = (n, extra = {}) => ({
  id: `cg-${n}`, title: `Loaf ${n} — "crust" [${'{'}]`, create_time: 1735700000 + n, current_node: `${n}-b`,
  mapping: {
    [`${n}-a`]: { id: `${n}-a`, parent: null, message: { author: { role: 'user' }, create_time: 1735700000 + n, content: { content_type: 'text', parts: [`Why is loaf ${n} \\ "flat" ]}, — café ☕?`] }, metadata: extra.metadata ?? {} } },
    [`${n}-b`]: { id: `${n}-b`, parent: `${n}-a`, message: { author: { role: 'assistant' }, create_time: 1735700001 + n, content: { content_type: 'text', parts: [`Loaf ${n} needs a longer proof.`] }, metadata: { model_slug: 'gpt-4o' } } },
  },
});

test('the elements of a JSON array are cut out exactly at any piece size, and a read starts again at an end it gave', t => {
  const folder = home(t);
  const items = [chat(1), { a: [1, { b: '}]' }], s: '\\"' }, [], chat(2), { emoji: '🍞🥖', nested: [[[{}]]] }];
  const path = join(folder, 'conversations.json');
  writeFileSync(path, `﻿ \n[ ${items.map(item => JSON.stringify(item, null, 1)).join(' ,\n')} ]\n`);
  assert.equal(firstByteOf(path), 0x5b);
  for (const piece of [1, 2, 3, 7, 64, 1 << 20]) {
    const read = [...jsonArrayElements(path, { piece_bytes: piece })];
    assert.deepEqual(read.map(element => JSON.parse(element.bytes.toString('utf8'))), items, `piece ${piece}`);
    const rest = [...jsonArrayElements(path, { at: read[2].end, piece_bytes: piece })];
    assert.deepEqual(rest.map(element => JSON.parse(element.bytes.toString('utf8'))), items.slice(3), `rest at piece ${piece}`);
  }
  writeFileSync(path, '[]');
  assert.deepEqual([...jsonArrayElements(path)], []);
  writeFileSync(path, '{"conversations": []}');
  assert.equal(firstByteOf(path), 0x7b);
  assert.throws(() => [...jsonArrayElements(path)], NotAJsonArray);
  writeFileSync(path, '[{"id": "a"}, {"id": "b"');
  assert.throws(() => [...jsonArrayElements(path)], /ends inside its array/);
  writeFileSync(path, '[1, 2]');
  assert.throws(() => [...jsonArrayElements(path)], /other than objects/);
});

test('a ChatGPT export is kept one conversation at a time, a stopped run starting again at the byte its cursor names', async t => {
  const folder = home(t);
  const conversations = Array.from({ length: 40 }, (_, n) => chat(n + 1));
  put(folder, 'Downloads/chatgpt/conversations.json', JSON.stringify(conversations));
  const clean = await doorFor(t);
  const whole = await importConversationsFrom({ input: { source: 'chatgpt-export' }, folder }, clean.context);
  assert.equal(whole.done, true);
  assert.equal(whole.conversations_kept, 40);
  assert.equal(whole.messages_added, 80);

  const busy = await doorFor(t);
  Object.assign(busy.trouble, { busyFrom: 120, busyCalls: 1000 });
  const first = await importConversationsFrom({ input: { source: 'chatgpt-export' }, folder }, busy.context);
  assert.equal(first.more, true);
  const cursor = ofType(busy.fake, 'conversation-import-cursor').find(value => value.file === 'Downloads/chatgpt/conversations.json');
  assert.equal(cursor.done, false);
  assert.ok(cursor.next.at > 0 && cursor.next.at < 40, JSON.stringify(cursor.next));
  // The byte it names is just past the last conversation it passed.
  const text = readFileSync(join(folder, 'Downloads/chatgpt/conversations.json'), 'utf8');
  assert.equal(Buffer.byteLength(JSON.stringify(conversations.slice(0, cursor.next.at))) - 1, cursor.next.byte);
  assert.equal(text.length > 0, true);

  busy.trouble.busyCalls = 0;
  const resumed = await importConversationsFrom({ input: { source: 'chatgpt-export' }, folder }, busy.context);
  assert.equal(resumed.more, false, JSON.stringify(resumed));
  const ids = fake => ofType(fake, 'message').map(message => message.source_ref).sort();
  assert.deepEqual(ids(busy.fake), ids(clean.fake));
  assert.equal(ofType(busy.fake, 'record:ai-conversation').length, 40);
});

test('a zipped ChatGPT export\'s files are found inside the zip and copied, entry names never read as paths', async t => {
  const folder = home(t);
  const withPhoto = chat(7, { metadata: { attachments: [{ id: 'file-ZP01', name: 'crumb.png', mime_type: 'image/png' }] } });
  const onlyPhoto = chat(8);
  onlyPhoto.mapping['8-a'].message.content.parts = [];
  onlyPhoto.mapping['8-a'].message.metadata = { attachments: [{ id: 'file-ZP02', name: 'loaf.jpg' }] };
  const zip = zipSync({
    'conversations.json': Buffer.from(JSON.stringify([withPhoto, onlyPhoto])),
    'file-ZP01-crumb.png': PNG,
    'user-abc/file-ZP02-loaf.jpg': JPEG,
    '../../escape/file-ZP03-x.png': PNG,
    '__MACOSX/._file-ZP01-crumb.png': Buffer.from('litter'),
  });
  put(folder, 'Downloads/chatgpt-export.zip', zip);
  const inZip = exportFilesInZip(zip);
  assert.equal(inZip.locate('file-ZP01').name, 'file-ZP01-crumb.png');
  assert.equal(inZip.locate('file-ZP02').folder, 'user-abc');
  assert.equal(inZip.locate('file-ZP03').name, 'file-ZP03-x.png', 'only its last name is kept');
  assert.equal(inZip.locate('file-ZP'), null);
  assert.deepEqual(inZip.locate('file-ZP01').read(), new Uint8Array(PNG));

  const { fake, context } = await doorFor(t);
  const result = await importConversationsFrom({ input: { source: 'chatgpt-export', files: ['Downloads/chatgpt-export.zip'] }, folder }, context);
  assert.equal(result.done, true, JSON.stringify(result));
  assert.deepEqual([result.conversations_kept, result.attachments_kept, result.attachments_not_kept], [2, 2, 0]);
  assert.deepEqual(Object.fromEntries([...fake.stored].map(([name, bytes]) => [name, id(bytes)])), {
    '/messages/ChatGPT/file-ZP01-crumb.png': id(PNG),
    '/messages/ChatGPT/file-ZP02-loaf.jpg': id(JPEG),
  });
  const photo = ofType(fake, 'message').find(message => message.source_ref === '8-a');
  assert.equal(photo.text, '');
  assert.deepEqual(photo.attachments.map(file => file.identity), [id(JPEG)]);
});

test('a Grok message of only an image, with no words, is kept with its file', async t => {
  const folder = home(t);
  put(folder, 'Downloads/grok/prod-grok-backend.json', JSON.stringify({ conversations: [{ conversation: { id: 'gk-i', title: 'Just a picture' }, responses: [
    { response: { _id: 'gk-i-a', sender: 'human', message: '', file_attachments: ['7a7a-asset'], create_time: { $date: { $numberLong: '1736000000000' } } } },
    { response: { _id: 'gk-i-b', sender: 'ASSISTANT', message: 'A lovely open crumb.', create_time: { $date: { $numberLong: '1736000004000' } }, model: 'grok-3' } },
    // No words and no file: still nothing to keep.
    { response: { _id: 'gk-i-c', sender: 'human', message: '', create_time: { $date: { $numberLong: '1736000008000' } } } }] }] }));
  put(folder, 'Downloads/grok/prod-mc-asset-server/7a7a-asset/content', JPEG);
  const { fake, context } = await doorFor(t);
  const result = await importConversationsFrom({ input: { source: 'grok-export' }, folder }, context);
  assert.equal(result.done, true, JSON.stringify(result));
  assert.deepEqual([result.messages_added, result.attachments_kept], [2, 1]);
  const image = ofType(fake, 'message').find(message => message.source_ref === 'gk-i-a');
  assert.equal(image.text, '');
  assert.deepEqual(image.attachments.map(file => [file.identity, file.media_type]), [[id(JPEG), 'image/jpeg']]);
  assert.deepEqual([...fake.stored.keys()], ['/messages/Grok/7a7a-asset.jpg']);
});
