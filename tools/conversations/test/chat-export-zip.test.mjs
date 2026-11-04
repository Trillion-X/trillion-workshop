// An account export can be brought in as the zip itself: the chat import (src/chat-import.mjs exportedConversations)
// reads its conversations*.json through the one archive reader (src/archive-entries.mjs, profile chat_export).
import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import { exportedConversations } from '../src/chat-import.mjs';
import { conversationsFrom } from '../src/chat-archives.mjs';

const bytes = text => new TextEncoder().encode(text);
const chat = id => ({ id, title: `Chat ${id}`, create_time: 1, mapping: {} });

test('a zip export gives the conversations of every conversations*.json, ignoring other entries and traversal names', () => {
  const zip = zipSync({
    'export/conversations-000.json': bytes(JSON.stringify([chat('a'), chat('b')])),
    'export/conversations-001.json': bytes(JSON.stringify([chat('c')])),
    '../../etc/conversations.json': bytes(JSON.stringify(chat('d'))),
    'export/user.json': bytes('{"email":"x"}'), '__MACOSX/export/._conversations-000.json': bytes('junk'),
  });
  assert.deepEqual(exportedConversations(zip).map(item => item.id), ['a', 'b', 'c', 'd']);
});

test('a plain JSON export still reads, one conversation or a list', () => {
  assert.deepEqual(exportedConversations(bytes(JSON.stringify(chat('x')))).map(item => item.id), ['x']);
  assert.deepEqual(exportedConversations(bytes(JSON.stringify([chat('x'), chat('y')]))).map(item => item.id), ['x', 'y']);
  assert.equal(conversationsFrom(exportedConversations(bytes(JSON.stringify([chat('x')])))).length, 1);
});

test('a zip with no conversations, a bad zip and non-JSON are refused in words', () => {
  assert.throws(() => exportedConversations(zipSync({ 'a.png': bytes('x') })), /no conversations\.json/);
  assert.throws(() => exportedConversations(Uint8Array.from([0x50, 0x4b, 1, 2, 3, 4])), /not a chat export/);
  assert.throws(() => exportedConversations(bytes('words')), /not JSON/);
  assert.throws(() => exportedConversations(zipSync({ 'conversations.json': bytes('{nope') })), /not JSON/);
});
