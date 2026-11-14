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
function personDoor(records = [], files = ['1f:' + 'a'.repeat(64)]) {
  const kept = new Map(records.map(record => [record.id, structuredClone(record)]));
  const door = recordsDoorFromCall(async (method, input) => {
    if (method === 'find_file') {
      if (!files.includes(input.name_or_identity)) throw new Error('No such file.');
      return { identity: input.name_or_identity };
    }
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
  }, { resource: '@own-records', filesResource: '@own-files' });
  return { door, kept };
}

let clock = Date.parse('2026-11-13T18:00:00.000Z');
const route = (door, path, method = 'GET', query = {}, body = {}) => answerTheMessageRoute({ path, method, query, body, browser: {} }, { door, now: () => (clock += 1000) });
const jobsOf = kept => [...kept.values()].filter(one => one.type === 'ai-job');
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

test('a send to one AI hands it that AI as a waiting job, once, and a send with no AI makes no job', async () => {
  const { door, kept } = personDoor();
  await route(door, '/messages/send', 'POST', {}, { app: 'Claude', conversation_id: 'c', text: 'hello', client_id: 'n1' });
  assert.equal(jobsOf(kept).length, 0);
  const body = { app: 'Claude', conversation_id: 'c', text: 'please look', client_id: 'n2', agent_id: 'agent:sample' };
  const sent = await route(door, '/messages/send', 'POST', {}, body);
  const [job] = jobsOf(kept);
  assert.equal(job.id, `ai-job:message:${sent.body.message_id}:agent:sample`);
  assert.equal(sent.body.delivery.event_id, job.id);
  assert.deepEqual([job.value.status, job.value.to_agent, job.value.input.arrived.message_id, job.value.next_call.arguments.conversation_id], ['waiting', 'agent:sample', sent.body.message_id, 'c']);
  const again = await route(door, '/messages/send', 'POST', {}, body);
  assert.equal(again.body.delivery.event_id, job.id);
  assert.equal(jobsOf(kept).length, 1, 'a retry makes no second job');
});

test('files ride by reference: each is one of the person\'s own, linked in the message and the job; another is refused', async () => {
  const mine = '1f:' + 'a'.repeat(64);
  const { door, kept } = personDoor();
  const sent = await route(door, '/messages/send-all', 'POST', {}, { text: 'see this', files: [{ identity: mine }], client_id: 'f1' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(sent.body.files, [mine]);
  assert.deepEqual(kept.get(sent.body.message_id).value.about, [{ kind: 'file', id: mine }]);
  const [job] = jobsOf(kept);
  assert.equal(job.id, `ai-job:message:${sent.body.message_id}`);
  assert.equal(job.value.refs.file_1, mine);
  assert.equal(job.value.to_agent, undefined, 'no AI is named, so any AI may take it');
  const other = await route(door, '/messages/send', 'POST', {}, { app: 'Claude', conversation_id: 'c', text: 'x', files: [{ identity: '1f:' + 'b'.repeat(64) }] });
  assert.equal(other.status, 403);
  assert.match(other.body.error, /is not one of your files\./);
  assert.equal((await route(door, '/messages/send', 'POST', {}, { app: 'Claude', conversation_id: 'c', files: [{}] })).status, 400);
  assert.equal(messageIds(kept).length, 1, 'a refused send keeps nothing');
});

test('send-all links an anchor and a reply, and a mentioned AI gets the job alone', async () => {
  const { door, kept } = personDoor();
  const sent = await route(door, '/messages/send-all', 'POST', {}, { text: 'about this', client_id: 'm1', anchor: { record: 'record:sample:1', part: { kind: 'words', from: 1, to: 4 } },
    reply_to: 'message:earlier', mentions: [{ kind: 'ai', value: 'agent:sample', label: 'Sample' }] });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(kept.get(sent.body.message_id).value.about, [
    { kind: 'record', id: 'record:sample:1', part: { kind: 'words', from: 1, to: 4 } }, { kind: 'message', id: 'message:earlier' }, { kind: 'agent', id: 'agent:sample' }]);
  assert.deepEqual(jobsOf(kept).map(job => [job.id, job.value.to_agent]), [[`ai-job:message:${sent.body.message_id}:agent:sample`, 'agent:sample']]);
  assert.deepEqual(sent.body.delivery, [{ agent_id: 'agent:sample', state: 'next_connection' }]);
  assert.equal((await route(door, '/messages/send-all', 'POST', {}, { text: 'x', mentions: [{ kind: 'NOT A KIND', value: 'v', label: 'l' }] })).status, 400);
});

test('the route row runs as the engine runs it, against the stand-in door with exactly its rights', async () => {
  const row = rowOf(rows, 'tool:answer-the-message-page-routes');
  const [sample] = row.verify;
  const ran = await answerOf(row, sample.input, sample);
  assert.equal(ran.status, 0, JSON.stringify(ran));
  assert.equal(ran.result.status, 200, JSON.stringify(ran.result));
  assert.ok(ran.kept.some(record => record.type === 'message'), 'the message is kept through the door');
});
