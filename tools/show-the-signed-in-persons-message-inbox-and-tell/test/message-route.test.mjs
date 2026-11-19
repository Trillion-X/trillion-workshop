// The web chat's message routes (src/message-route.mjs) over rows the test makes up. The route holds no database: the
// test plays the caller, giving the message rows it read as `stored.records` and writing each `keep` batch back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerTheMessageRoute } from '../src/message-route.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const FILE = '1f:' + 'a'.repeat(64);

// A store of the caller's own rows: each keep batch is written as new rows (invariant 2), and a `stored` view is given to the route.
function personStore(file_identities = [FILE]) {
  const records = [];
  const seen = new Set();
  return {
    records,
    stored: () => ({ records: structuredClone(records), file_identities }),
    write(batch) {
      for (const row of batch) {
        if (seen.has(row.id)) throw new Error(`a second write of ${row.id}`);
        seen.add(row.id);
        records.push(structuredClone(row));
      }
    },
  };
}

let clock = Date.parse('2026-11-13T18:00:00.000Z');
const now = () => (clock += 1000);

async function route(store, path, method = 'GET', query = {}, body = {}) {
  const answered = await answerTheMessageRoute({ path, method, query, body, browser: {}, stored: store.stored() }, { now });
  if (answered.keep?.length) store.write(answered.keep);
  return answered;
}
const jobsOf = store => store.records.filter(one => one.type === 'ai-job');
const messageIds = store => store.records.filter(one => one.type === 'message').map(one => one.id);

test('a message sent through POST /messages/send is a message row and shows in GET /messages and /messages/thread', async () => {
  const store = personStore();
  const sent = await route(store, '/messages/send', 'POST', {}, { app: 'Claude', conversation_id: 'sample-chat-1', text: 'Plan the sample ferns', client_id: 'fern-1' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.recorded, 1);
  assert.equal(sent.body.delivery.state, 'next_connection');
  const [row] = messageIds(store);
  assert.equal(row, sent.body.message_id);
  assert.match(row, /^message:2026-11-13T18:00:01\.000Z:[0-9a-f]{24}$/);
  const value = store.records.find(one => one.id === row).value;
  assert.deepEqual([value.app, value.conversation_id, value.speaker, value.text, value.source_ref], ['Claude', 'sample-chat-1', 'person', 'Plan the sample ferns', 'client:fern-1']);

  const list = await route(store, '/messages');
  assert.equal(list.status, 200);
  assert.equal(list.body.conversations.length, 1);
  assert.deepEqual([list.body.conversations[0].app, list.body.conversations[0].conversation_id, list.body.conversations[0].latest.id], ['Claude', 'sample-chat-1', row]);
  assert.deepEqual((await route(store, '/messages/threads', 'GET', { limit: '12' })).body, list.body);

  const read = await route(store, '/messages/thread', 'GET', { app: 'Claude', conversation_id: 'sample-chat-1' });
  assert.deepEqual(read.body.messages.map(message => [message.id, message.text]), [[row, 'Plan the sample ferns']]);
});

test('the same client_id sent again is the message already kept; the same words under another id are a new message', async () => {
  const store = personStore();
  const body = { app: 'Claude', conversation_id: 'c', text: 'yes', client_id: 'a' };
  const first = await route(store, '/messages/send', 'POST', {}, body);
  const again = await route(store, '/messages/send', 'POST', {}, body);
  assert.deepEqual([again.body.message_id, again.body.recorded], [first.body.message_id, 0]);
  assert.deepEqual(again.keep, [], 'a repeat keeps nothing');
  assert.equal(messageIds(store).length, 1);
  await route(store, '/messages/send', 'POST', {}, { ...body, client_id: 'b' });
  assert.equal(messageIds(store).length, 2);
});

test('send-all keeps one message in the shared Trillion conversation, and threads page newest first', async () => {
  const store = personStore();
  const all = await route(store, '/messages/send-all', 'POST', {}, { text: 'Hello every AI', client_id: 'x1' });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(store.records.find(one => one.id === all.body.message_id).value.conversation_id, 'trillion:shared');
  assert.equal(store.records.find(one => one.id === all.body.message_id).value.app, 'Trillion');
  for (const n of [1, 2, 3]) await route(store, '/messages/send', 'POST', {}, { app: `App${n}`, conversation_id: `c${n}`, text: `w${n}` });
  const page = await route(store, '/messages/threads', 'GET', { limit: '2' });
  assert.deepEqual(page.body.conversations.map(one => one.app), ['App3', 'App2']);
  assert.ok(page.body.next_before);
  const rest = await route(store, '/messages/threads', 'GET', { limit: '5', before: page.body.next_before });
  assert.deepEqual(rest.body.conversations.map(one => one.app), ['App1', 'Trillion']);
});

test('refusals come in the old words and keep nothing', async () => {
  const store = personStore();
  assert.equal((await route(store, '/messages/send', 'POST', {}, { app: 'Claude', text: 'x' })).body.error, 'Choose an AI and write a message.');
  assert.equal((await route(store, '/messages/send-all', 'POST', {}, { text: '  ' })).body.error, 'Write a message for your AIs.');
  assert.equal((await route(store, '/messages/send', 'POST', {}, { app: 'a', conversation_id: 'c', text: 'x', client_id: '' })).status, 400);
  assert.equal((await route(store, '/messages/thread', 'GET', {})).body.error, 'Choose a conversation to read.');
  assert.equal((await route(store, '/messages/nothing')).status, 404);
  assert.equal(store.records.length, 0);
});

test('a send to one AI hands it that AI as a waiting job, once, and a send with no AI makes no job', async () => {
  const store = personStore();
  await route(store, '/messages/send', 'POST', {}, { app: 'Claude', conversation_id: 'c', text: 'hello', client_id: 'n1' });
  assert.equal(jobsOf(store).length, 0);
  const body = { app: 'Claude', conversation_id: 'c', text: 'please look', client_id: 'n2', agent_id: 'agent:sample' };
  const sent = await route(store, '/messages/send', 'POST', {}, body);
  const [job] = jobsOf(store);
  assert.equal(job.id, `ai-job:message:${sent.body.message_id}:agent:sample`);
  assert.equal(sent.body.delivery.event_id, job.id);
  assert.deepEqual([job.value.status, job.value.to_agent, job.value.input.arrived.message_id, job.value.next_call.arguments.conversation_id], ['waiting', 'agent:sample', sent.body.message_id, 'c']);
  const again = await route(store, '/messages/send', 'POST', {}, body);
  assert.equal(again.body.delivery.event_id, job.id);
  assert.equal(jobsOf(store).length, 1, 'a retry makes no second job');
});

test('files ride by reference: each is one of the person\'s own, linked in the message and the job; another is refused', async () => {
  const store = personStore();
  const sent = await route(store, '/messages/send-all', 'POST', {}, { text: 'see this', files: [{ identity: FILE }], client_id: 'f1' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(sent.body.files, [FILE]);
  assert.deepEqual(store.records.find(one => one.id === sent.body.message_id).value.about, [{ kind: 'file', id: FILE }]);
  const [job] = jobsOf(store);
  assert.equal(job.id, `ai-job:message:${sent.body.message_id}`);
  assert.equal(job.value.refs.file_1, FILE);
  assert.equal(job.value.to_agent, undefined, 'no AI is named, so any AI may take it');
  const other = await route(store, '/messages/send', 'POST', {}, { app: 'Claude', conversation_id: 'c', text: 'x', files: [{ identity: '1f:' + 'b'.repeat(64) }] });
  assert.equal(other.status, 403);
  assert.match(other.body.error, /is not one of your files\./);
  assert.equal((await route(store, '/messages/send', 'POST', {}, { app: 'Claude', conversation_id: 'c', files: [{}] })).status, 400);
  assert.equal(messageIds(store).length, 1, 'a refused send keeps nothing');
});

test('files cannot be sent when the caller gives no list of the person\'s files', async () => {
  const store = personStore(null);
  const sent = await route(store, '/messages/send', 'POST', {}, { app: 'Claude', conversation_id: 'c', text: 'x', files: [{ identity: FILE }] });
  assert.equal(sent.status, 400);
  assert.equal(sent.body.error, 'Files cannot be sent from here.');
});

test('send-all links an anchor and a reply, and a mentioned AI gets the job alone', async () => {
  const store = personStore();
  const sent = await route(store, '/messages/send-all', 'POST', {}, { text: 'about this', client_id: 'm1', anchor: { record: 'record:sample:1', part: { kind: 'words', from: 1, to: 4 } },
    reply_to: 'message:earlier', mentions: [{ kind: 'ai', value: 'agent:sample', label: 'Sample' }] });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(store.records.find(one => one.id === sent.body.message_id).value.about, [
    { kind: 'record', id: 'record:sample:1', part: { kind: 'words', from: 1, to: 4 } }, { kind: 'message', id: 'message:earlier' }, { kind: 'agent', id: 'agent:sample' }]);
  assert.deepEqual(jobsOf(store).map(job => [job.id, job.value.to_agent]), [[`ai-job:message:${sent.body.message_id}:agent:sample`, 'agent:sample']]);
  assert.deepEqual(sent.body.delivery, [{ agent_id: 'agent:sample', state: 'next_connection' }]);
  assert.equal((await route(store, '/messages/send-all', 'POST', {}, { text: 'x', mentions: [{ kind: 'NOT A KIND', value: 'v', label: 'l' }] })).status, 400);
});

test('the route is a function of its input: nothing is written by it, and the row names no records method', async () => {
  const row = rows.records[0].payload;
  const [sample] = row.verify;
  const answered = await answerTheMessageRoute(sample.input, { now: () => Date.parse('2026-11-13T18:00:00.000Z') });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.ok(answered.keep.some(one => one.type === 'message'), 'the message comes back to be kept');
  const text = JSON.stringify(row);
  assert.doesNotMatch(text, /records:(read|write|list)|records-door|records door/);
  assert.equal(row.invoke.argv[1], '/opt/workflows/do-work/run-a-function.mjs');
});
