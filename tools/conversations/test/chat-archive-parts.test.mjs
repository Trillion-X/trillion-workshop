// tools/conversations/test/chat-archive-parts.test.mjs (moved from Trillion-X/trillion test/chat-archive-parts.test.mjs)
//
// A message longer than one kept message holds (src/messages.mjs MAX_TEXT) is brought in as parts
// (src/chat-archives.mjs invariant 4): its parts joined are its words exactly, each fits, they keep their order and
// their nodes are stable, so bringing the same chat in again adds nothing twice. Before this, one long pasted message
// refused its whole page of an account export ("messages[0].text is 388347 characters").
import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationFrom } from '../read-data/chat-archives.mjs';
import { MAX_TEXT } from '../../keep-and-wake-ai-sessions-on-this-computer/src/messages.mjs';

const long = `${'a'.repeat(MAX_TEXT - 10)}\n${'b'.repeat(MAX_TEXT)}😀${'c'.repeat(30)}`;
const archive = {
  id: 'conv-1', title: 'Long paste', current_node: 'n2',
  mapping: {
    n1: { id: 'n1', parent: null, message: { author: { role: 'user' }, create_time: 1790000000, content: { parts: [long] } } },
    n2: { id: 'n2', parent: 'n1', message: { author: { role: 'assistant' }, create_time: 1790000001, content: { parts: ['short reply'] } } },
  },
};

test('a long message is kept as ordered parts whose words join to it exactly', () => {
  const chat = conversationFrom(archive);
  const parts = chat.messages.filter(message => message.node.startsWith('n1'));
  assert.ok(parts.length >= 3);
  assert.equal(parts.map(message => message.text).join(''), long);
  assert.ok(parts.every(message => message.text.length <= MAX_TEXT && message.speaker === 'person'));
  assert.deepEqual(parts.map(message => message.node), parts.map((_, index) => `n1:part-${index + 1}`));
  assert.equal(parts[0].text.endsWith('\n'), true, 'the first part ends at the line break in its last tenth');
  const times = parts.map(message => Date.parse(message.at));
  assert.deepEqual(times, times.map((_, index) => times[0] + index));
  assert.ok(parts.every(message => !/[\ud800-\udbff]$/.test(message.text)), 'no part ends inside a character pair');
  assert.equal(chat.messages.at(-1).text, 'short reply');
  assert.equal(chat.messages.at(-1).node, 'n2');
});

test('reading the same archive again gives the same parts', () => {
  assert.deepEqual(conversationFrom(archive), conversationFrom(archive));
});

test('a long message read off its page is kept in parts too', () => {
  const chat = conversationFrom({ conversation_id: 'page-1', title: 'Page', messages: [{ id: 'm1', speaker: 'person', text: long }] });
  assert.equal(chat.messages.map(message => message.text).join(''), long);
  assert.equal(chat.messages[0].node, 'm1:part-1');
});

test('an importer that names a smaller bound (one records door write) gets parts under it, made the same way', () => {
  const chat = conversationFrom(archive, 'ChatGPT', { most_text: 16000 });
  const parts = chat.messages.filter(message => message.node.startsWith('n1'));
  assert.equal(parts.map(message => message.text).join(''), long);
  assert.ok(parts.every(message => message.text.length <= 16000));
  assert.deepEqual(parts.map(message => message.node), parts.map((_, index) => `n1:part-${index + 1}`));
});
