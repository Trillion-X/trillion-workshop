// The web chat's message routes as the engine runs them through tool:answer-the-message-page-routes (workshop-routes):
// src/message-route.mjs keeps each message the person sends as one `message` row through the records door and reads
// them back. Every record here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { recordsDoorFromCall, RecordsDoorError } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { answerTheMessageRoute } from '../src/message-route.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

// The person's records as the door keeps them: read, list (greatest id first when reversed, in pages of two, below an id)
// and conditional writes.
function personDoor(records = []) {
  const kept = new Map(records.map(record => [record.id, structuredClone(record)]));
  const door = recordsDoorFromCall(async (method, input) => {
    if (method === 'records:read') {
      const one = kept.get(input.id);
      return { id: input.id, type: input.type, value: one?.type === input.type ? structuredClone(one.value) : null };
    }
    if (method === 'records:list') {
      let ids = [...kept.values()].filter(one => one.type === input.type && (!input.prefix || one.id.startsWith(input.prefix))
        && (input.below === undefined || one.id < input.below)).map(one => one.id).sort();
      if (input.reverse) ids.reverse();
      const from = input.after === undefined ? 0 : ids.indexOf(input.after) + 1;
      const page = ids.slice(from, from + 2);
      return { records: page.map(id => structuredClone(kept.get(id))), next: from + 2 < ids.length ? page.at(-1) : null };
    }
    if (method === 'records:write') {
      for (const item of input.records) {
        const now = kept.get(item.id) ?? null;
        const fine = item.expected === null ? now === null : now && now.type === item.expected.type && isDeepStrictEqual(now.value, item.expected.value);
        if (!fine) throw new RecordsDoorError('original_command_conflict', 'changed', 'not_started');
      }
      for (const { expected: _expected, ...item } of input.records) item.value === null ? kept.delete(item.id) : kept.set(item.id, item);
      return { changed: input.records.length, write_count: input.records.length };
    }
    throw new Error(`unexpected ${method}`);
  }, { resource: '@own-records' });
  return { door, kept };
}

let clock = Date.parse('2026-11-13T18:00:00.000Z');
const route = (door, path, method = 'GET', query = {}, body = {}) => answerTheMessageRoute({ path, method, query, body, browser: {} }, { door, now: () => (clock += 1000) });
const messageIds = kept => [...kept.values()].filter(one => one.type === 'message').map(one => one.id);

test('a message sent through POST /messages/send is a message row and shows in GET /messages and /messages/thread', async () => {
  const { door, kept } = personDoor();
  const sent = await route(door, '/messages/send', 'POST', {}, { app: 'Claude', conversation_id: 'sample-chat-1', text: 'Plan the sample ferns', client_id: 'fern-1' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.recorded, 1);
  assert.equal(sent.body.delivery.state, 'next_connection');
  const [row] = messageIds(kept);
  assert.equal(row, sent.body.message_id);
  assert.match(row, /^message:2026-11-13T18:00:01\.000Z:[0-9a-f]{24}$/);
  const value = kept.get(row).value;
  assert.deepEqual([value.app, value.conversation_id, value.speaker, value.text, value.source_ref], ['Claude', 'sample-chat-1', 'person', 'Plan the sample ferns', 'client:fern-1']);

  const list = await route(door, '/messages');
  assert.equal(list.status, 200);
  assert.equal(list.body.conversations.length, 1);
  assert.deepEqual([list.body.conversations[0].app, list.body.conversations[0].conversation_id, list.body.conversations[0].latest.id], ['Claude', 'sample-chat-1', row]);
  assert.deepEqual((await route(door, '/messages/threads', 'GET', { limit: '12' })).body, list.body);

  const read = await route(door, '/messages/thread', 'GET', { app: 'Claude', conversation_id: 'sample-chat-1' });
  assert.deepEqual(read.body.messages.map(message => [message.id, message.text]), [[row, 'Plan the sample ferns']]);
});

test('the same client_id sent again is the message already kept; the same words under another id are a new message', async () => {
  const { door, kept } = personDoor();
  const body = { app: 'Claude', conversation_id: 'c', text: 'yes', client_id: 'a' };
  const first = await route(door, '/messages/send', 'POST', {}, body);
  const again = await route(door, '/messages/send', 'POST', {}, body);
  assert.deepEqual([again.body.message_id, again.body.recorded], [first.body.message_id, 0]);
  assert.equal(messageIds(kept).length, 1);
  await route(door, '/messages/send', 'POST', {}, { ...body, client_id: 'b' });
  assert.equal(messageIds(kept).length, 2);
});

test('send-all keeps one message in the shared Trillion conversation, and threads page newest first', async () => {
  const { door, kept } = personDoor();
  const all = await route(door, '/messages/send-all', 'POST', {}, { text: 'Hello every AI', client_id: 'x1' });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(kept.get(all.body.message_id).value.conversation_id, 'trillion:shared');
  assert.equal(kept.get(all.body.message_id).value.app, 'Trillion');
  for (const n of [1, 2, 3]) await route(door, '/messages/send', 'POST', {}, { app: `App${n}`, conversation_id: `c${n}`, text: `w${n}` });
  const page = await route(door, '/messages/threads', 'GET', { limit: '2' });
  assert.deepEqual(page.body.conversations.map(one => one.app), ['App3', 'App2']);
  assert.ok(page.body.next_before);
  const rest = await route(door, '/messages/threads', 'GET', { limit: '5', before: page.body.next_before });
  assert.deepEqual(rest.body.conversations.map(one => one.app), ['App1', 'Trillion']);
});

test('refusals come in the old words and keep nothing', async () => {
  const { door, kept } = personDoor();
  assert.equal((await route(door, '/messages/send', 'POST', {}, { app: 'Claude', text: 'x' })).body.error, 'Choose an AI and write a message.');
  assert.equal((await route(door, '/messages/send-all', 'POST', {}, { text: '  ' })).body.error, 'Write a message for your AIs.');
  assert.equal((await route(door, '/messages/send', 'POST', {}, { app: 'a', conversation_id: 'c', text: 'x', client_id: '' })).status, 400);
  assert.equal((await route(door, '/messages/thread', 'GET', {})).body.error, 'Choose a conversation to read.');
  assert.equal((await route(door, '/messages/nothing')).status, 404);
  assert.equal(kept.size, 0);
});

test('the route row runs as the engine runs it, against the stand-in door with exactly its rights', async () => {
  const row = rowOf(rows, 'tool:answer-the-message-page-routes');
  const [sample] = row.verify;
  const ran = await answerOf(row, sample.input, sample);
  assert.equal(ran.status, 0, JSON.stringify(ran));
  assert.equal(ran.result.status, 200, JSON.stringify(ran.result));
  assert.ok(ran.kept.some(record => record.type === 'message'), 'the message is kept through the door');
});
