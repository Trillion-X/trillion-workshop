// test/read-cloud-sessions.test.mjs
//
// harness/read-cloud-sessions.mjs cuts a finished cloud session's events down to what it was asked, what it said to
// the person after the last thing it was asked, the pull requests it named, its pushes and the questions it asked.
// Tool results and sub-agent messages are not the person's words, and importing the file runs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { briefFrom, briefText, readRecord, whatItSaid } from '../harness/read-cloud-sessions.mjs';

const at = minute => `2026-01-02T03:${String(minute).padStart(2, '0')}:00Z`;
const user = (minute, content, extra = {}) => ({ type: 'user', created_at: at(minute), parent_tool_use_id: null, message: { role: 'user', content }, ...extra });
const assistant = (minute, content, extra = {}) => ({ type: 'assistant', created_at: at(minute), parent_tool_use_id: null, message: { role: 'assistant', content }, ...extra });

test('the task, the later asks and the messages since the last ask are kept apart', () => {
  const said = whatItSaid([
    user(1, 'Make the bakery list sortable.'),
    assistant(2, [{ type: 'text', text: 'Starting on the list.' }]),
    user(3, 'Also keep the old order as a choice.'),
    assistant(4, [{ type: 'text', text: 'Done: both orders. Left: the price column.' }]),
  ]);
  assert.equal(said.first_task, 'Make the bakery list sortable.');
  assert.deepEqual(said.later_user_messages.map(message => message.text), ['Also keep the old order as a choice.']);
  assert.deepEqual(said.final_messages.map(message => message.text), ['Done: both orders. Left: the price column.']);
  assert.equal(said.event_count, 4);
});

test('pull requests and pushes come from tool results and messages, questions from the question tool', () => {
  const said = whatItSaid([
    user(1, 'Ship it.'),
    assistant(2, [{ type: 'tool_use', name: 'Bash', input: { command: 'git push' } }]),
    user(3, [{ type: 'tool_result', content: 'To https://github.com/example-org/bakery\n * [new branch] side -> side' }]),
    assistant(4, [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: 'Merge now or wait for review?' } }]),
    assistant(5, [{ type: 'text', text: 'Opened https://github.com/example-org/bakery/pull/7 and https://github.com/example-org/bakery/pull/7 again.' }]),
  ]);
  assert.deepEqual(said.pull_requests, ['https://github.com/example-org/bakery/pull/7']);
  assert.equal(said.pushes.length, 1);
  assert.match(said.questions[0], /Merge now or wait for review/);
});

test('a sub-agent message and a tool result are not the person speaking', () => {
  const said = whatItSaid([
    user(1, 'Count the loaves.'),
    user(2, 'sub-agent prompt', { parent_tool_use_id: 'tool-1' }),
    assistant(3, [{ type: 'text', text: 'sub-agent answer' }], { parent_tool_use_id: 'tool-1' }),
    user(4, [{ type: 'tool_result', content: '12 loaves' }]),
    assistant(5, [{ type: 'text', text: 'There are 12 loaves.' }]),
  ]);
  assert.deepEqual(said.later_user_messages, []);
  assert.deepEqual(said.final_messages.map(message => message.text), ['There are 12 loaves.']);
});

test('a session that never answered gives empty parts, not an error', () => {
  const said = whatItSaid([user(1, 'Hello')]);
  assert.deepEqual(said.final_messages, []);
  assert.deepEqual(said.pull_requests, []);
  assert.deepEqual(said.questions, []);
});

// A door answering records:read the way the person's door does, to a request with the right key.
async function door(t, records) {
  const asked = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { input } = JSON.parse(body).params.arguments;
    asked.push({ authorization: request.headers.authorization, ...JSON.parse(body).params.arguments });
    if (request.headers.authorization !== 'Bearer made-up-key') { response.writeHead(401); response.end('{}'); return; }
    const value = records[input.id]?.type === input.type ? records[input.id].value : null;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { id: input.id, type: input.type, value } } })}\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, asked };
}

test('start and send take the brief from a Trillion row by its record id, so no brief file is written', async t => {
  const { url, asked } = await door(t, {
    'record:brief:bakery-list': { type: 'record:brief', value: { brief: 'Make the bakery list sortable.', by: 'lead' } },
    'record:brief:plain': { type: 'record:brief', value: 'Add the price column.' },
  });
  const read = id => readRecord(id, { url, key: 'made-up-key' });
  assert.equal(await briefFrom('record:brief:bakery-list', { read }), 'Make the bakery list sortable.');
  assert.equal(await briefFrom('record:brief:plain', { read }), 'Add the price column.');
  assert.deepEqual(asked[0].input, { id: 'record:brief:bakery-list', type: 'record:brief' });
  assert.equal(asked[0].method, 'records:read');
  await assert.rejects(briefFrom('record:brief:missing', { read }), /record:brief:missing: no such record/);
  await assert.rejects(readRecord('record:brief:plain', { url, key: 'wrong-key' }), /the door answered 401/);
});

test('start and send take the brief from standard input when it is - or not given', async () => {
  assert.equal(await briefFrom('-', { stdin: Readable.from(['Ship the ', 'sorted list.\n']) }), 'Ship the sorted list.');
  assert.equal(await briefFrom(undefined, { stdin: Readable.from(['From a pipe.']) }), 'From a pipe.');
  await assert.rejects(briefFrom('-', { stdin: Readable.from(['  \n']) }), /standard input: no brief text/);
});

test('a row value is read as text from its brief, text, body, message or says field, and refused naming them', () => {
  assert.equal(briefText('record:brief:x', { text: ' Do it. ' }), 'Do it.');
  assert.equal(briefText('record:brief:x', { says: 'Say it.' }), 'Say it.');
  assert.throws(() => briefText('record:brief:x', { count: 3 }), /holds no text in brief, text, body, message, says/);
});
