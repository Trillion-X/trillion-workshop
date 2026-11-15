// test/read-cloud-sessions.test.mjs
//
// harness/read-cloud-sessions.mjs cuts a finished cloud session's events down to what it was asked, what it said to
// the person after the last thing it was asked, the pull requests it named, its pushes and the questions it asked.
// Tool results and sub-agent messages are not the person's words, and importing the file runs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { briefFrom, briefText, readRecord, whatItSaid, firstUserTextPage, readFirstUserText, dispatchCloudSessions } from '../harness/read-cloud-sessions.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const at = minute => `2026-01-02T03:${String(minute).padStart(2, '0')}:00Z`;
const user = (minute, content, extra = {}) => ({ type: 'user', created_at: at(minute), parent_tool_use_id: null, message: { role: 'user', content }, ...extra });
const assistant = (minute, content, extra = {}) => ({ type: 'assistant', created_at: at(minute), parent_tool_use_id: null, message: { role: 'assistant', content }, ...extra });

test('the summary marks its 4000-unit cut; the source read keeps the entire long text', () => {
  const original = 'A'.repeat(4000) + 'The original ending matters.';
  const events = [user(1, original, { uuid: 'first-message' }), user(2, 'A later request.')];
  const summary = whatItSaid(events);
  assert.equal(summary.first_task.length, 4000);
  assert.equal(summary.first_task_truncated, true);
  assert.equal(summary.first_task_total_utf16_units, original.length);
  const read = firstUserTextPage(events, { session: 'session_fixture' });
  assert.equal(Buffer.from(read.byte_page.base64, 'base64').toString('utf8'), original);
  assert.equal(read.source.event_id, 'first-message');
  assert.equal(read.source.whole_message, true);
  assert.equal(read.byte_page.complete, true);
});

test('UTF8 byte pages reconstruct across multibyte splits with the canonical content identity', () => {
  const original = '🙂漢é'.repeat(1700);
  const events = [user(1, original)];
  const first = firstUserTextPage(events, { session: 'one', length: 7 });
  const chunks = [Buffer.from(first.byte_page.base64, 'base64')];
  let page = first;
  while (!page.byte_page.complete) {
    page = firstUserTextPage(events, { session: 'one', offset: page.byte_page.next_after_byte, length: 7, snapshot: first.source.snapshot });
    assert.equal(page.source.snapshot, first.source.snapshot);
    assert.equal(page.byte_page.blake3, first.byte_page.blake3);
    chunks.push(Buffer.from(page.byte_page.base64, 'base64'));
  }
  const rebuilt = Buffer.concat(chunks);
  assert.equal(rebuilt.toString('utf8'), original);
  assert.equal(rebuilt.length, first.byte_page.total);
  assert.equal(makeHashCodeHexFromBytes(rebuilt), `1f:${first.byte_page.blake3}`);
  assert.equal(page.byte_page.next_after_byte, null);
});

test('EOF, empty text and bad bounds are explicit; continuations require the original source snapshot', () => {
  const events = [user(1, 'é')];
  const first = firstUserTextPage(events);
  assert.deepEqual(firstUserTextPage(events, { offset: 2, snapshot: first.source.snapshot }).byte_page,
    { total: 2, blake3: first.byte_page.blake3, offset: 2, length: 0, base64: '', next_after_byte: null, complete: true });
  assert.equal(firstUserTextPage([user(1, '')]).status, 'text-user-message');
  assert.equal(firstUserTextPage([user(1, '')]).byte_page.total, 0);
  for (const bounds of [{ offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { length: 0 }, { length: 65537 }, { length: 1.5 }, { snapshot: 'wrong' }, { offset: 1 }]) assert.throws(() => firstUserTextPage(events, bounds));
  assert.throws(() => firstUserTextPage(events, { offset: 3, snapshot: first.source.snapshot }), /past the end/);
  assert.throws(() => firstUserTextPage(events, { session: 'different', snapshot: first.source.snapshot }), /source changed/);
  assert.throws(() => firstUserTextPage([user(1, '\ud800')]), /cannot be represented losslessly/);
});

test('the first real user stays first, including non-text content; tool replies never become the prompt', () => {
  const tools = [user(1, [{ type: 'tool_result', content: 'Tool text is not the prompt.' }]), user(2, 'Subagent text', { parent_tool_use_id: 'tool-a' })];
  assert.equal(firstUserTextPage(tools).status, 'no-user-message');
  const image = user(3, [{ type: 'image', source: { data: 'synthetic-image' } }]);
  const onlyImage = firstUserTextPage([...tools, image, user(4, 'Do not substitute this later message.')]);
  assert.equal(onlyImage.status, 'non-text-user-message');
  assert.equal(onlyImage.source.event_index, 2);
  assert.equal(onlyImage.source.non_text_blocks, 1);
  assert.equal(onlyImage.byte_page.total, 0);
  const mixed = firstUserTextPage([user(1, [{ type: 'text', text: 'First\n' }, { type: 'image' }, { type: 'text', text: 'Last' }])]);
  assert.equal(mixed.status, 'mixed-user-message');
  assert.equal(mixed.source.whole_message, false);
  assert.equal(mixed.source.projection, 'text-blocks-joined-with-newlines');
  assert.equal(Buffer.from(mixed.byte_page.base64, 'base64').toString(), 'First\n\nLast');
  assert.throws(() => firstUserTextPage([user(1, [{ type: 'text', text: 3 }]), user(2, 'Later')]), /invalid text block/);
});

test('source pin changes for changed text, attachment or message identity, even with identical text', () => {
  const original = [user(1, [{ type: 'text', text: 'Text' }, { type: 'image', source: 'first' }], { uuid: 'message-one' })];
  const snapshot = firstUserTextPage(original).source.snapshot;
  for (const changed of [[], [user(1, 'Changed')], [user(1, original[0].message.content, { uuid: 'message-two' })], [user(1, [{ type: 'text', text: 'Text' }, { type: 'image', source: 'second' }], { uuid: 'message-one' })]]) assert.throws(() => firstUserTextPage(changed, { snapshot }), /source changed/);
});

test('real read-first dispatch asks only the named session with header auth and pages until its first user', async () => {
  const requests = [], output = [];
  let authenticated = 0;
  const events = [user(1, [{ type: 'tool_result', content: 'not a prompt' }]), user(2, '漢字🙂'.repeat(2000), { uuid: 'real-first' })];
  const dependencies = {
    authenticate: folder => { authenticated++; assert.equal(folder, '.claude-fixture'); return { org: 'synthetic-org', token: 'synthetic-token' }; },
    request: async (url, options) => {
      requests.push({ url, options });
      assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
      assert.equal(options.headers.authorization, 'Bearer synthetic-token');
      assert.equal(options.headers['x-organization-uuid'], 'synthetic-org');
      assert.ok(url.startsWith('https://api.anthropic.com/v1/sessions/session_fixture/events?limit=1000'));
      const second = url.includes('after_id=');
      return Response.json({ data: [events[second ? 1 : 0]], has_more: true, last_id: second ? 'user-event' : 'tool/event' });
    },
    print: line => output.push(line),
  };
  const first = await dispatchCloudSessions(['read-first', '.claude-fixture', 'session_fixture', '0', '17'], dependencies);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].url.endsWith('&after_id=tool%2Fevent'));
  assert.equal(first.source.event_id, 'real-first');
  assert.equal(first.byte_page.length, 17);
  assert.equal(authenticated, 1);
  assert.ok(!output.join('').includes('synthetic-token'));
  const second = await dispatchCloudSessions(['read-first', '.claude-fixture', 'session_fixture', '17', '17', first.source.snapshot], dependencies);
  assert.equal(second.byte_page.offset, 17);
  for (const args of [['read-first', '.claude-fixture', '../escape'], ['read-first', '../folder', 'session_fixture'], ['read-first', '.claude-fixture', 'session_fixture', '-1'], ['read-first', '.claude-fixture', 'session_fixture', '1'], ['read-first', '.claude-fixture', 'session_fixture', '0', '65537']]) await assert.rejects(dispatchCloudSessions(args, dependencies));
  assert.equal(authenticated, 2, 'invalid requests never read a sign-in');
  await assert.rejects(readFirstUserText('.claude-fixture', 'session_fixture', {}, { authenticate: dependencies.authenticate, request: async () => new Response('provider echoed synthetic-token', { status: 403 }) }), error => !error.message.includes('synthetic-token') && /HTTP 403/.test(error.message));
});

test('a read refuses an incomplete events cursor instead of claiming a missing first user', async () => {
  const authenticate = () => ({ org: 'synthetic', token: 'synthetic' });
  for (const page of [{ data: [], has_more: true }, { data: [assistant(1, 'System output')], has_more: true }, { data: null, has_more: false }]) {
    await assert.rejects(readFirstUserText('.claude-fixture', 'session_fixture', {}, { authenticate, request: async () => Response.json(page) }), /cursor did not advance|no data array/);
  }
  let calls = 0;
  await assert.rejects(readFirstUserText('.claude-fixture', 'session_fixture', {}, { authenticate, request: async () => {
    calls++;
    return Response.json({ data: [assistant(1, 'System output')], has_more: true, last_id: 'repeated' });
  } }), /cursor did not advance/);
  assert.equal(calls, 2);
});

test('strict page metadata is validated before either no-user completion or accepting its first user', async () => {
  const authenticate = () => ({ org: 'synthetic', token: 'synthetic' });
  for (const data of [[], [user(1, 'An apparent first prompt')]]) {
    for (const has_more of [undefined, null, 0, 1, 'false', {}, []]) {
      await assert.rejects(readFirstUserText('.claude-fixture', 'session_fixture', {}, {
        authenticate, request: async () => Response.json({ data, has_more }),
      }), /has_more must be a boolean/);
    }
  }
  for (const page of [null, [], { data: [user(1, 'First')], has_more: true }, { data: [user(1, 'First')], has_more: true, last_id: 3 }]) {
    await assert.rejects(readFirstUserText('.claude-fixture', 'session_fixture', {}, {
      authenticate, request: async () => Response.json(page),
    }), /has_more must be a boolean|cursor did not advance/);
  }
});

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
