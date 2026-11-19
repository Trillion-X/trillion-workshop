// test/ag-ui-agent.test.mjs
//
// Any AG-UI agent as one of the person's AIs (harness/ag-ui-agent.mjs, `example serve --ag-ui URL`): a real HTTP
// AG-UI agent on this computer is run on a taken job, asks for an offered Example tool (run here, as this AI), is
// given its answer and answers; an interrupt keeps the job with what is in the way; a tool it was not offered never
// runs. The frames it sends are read by the one wire module (harness/ag-ui-wire.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runOnAgUi, taskMessages } from '../do-work/ag-ui-agent.mjs';
import { foldRun, sseEvents, sseFrame } from '../../offer-my-work-as-ag-ui-events/harness/ag-ui-wire.mjs';
import { serveOnce, speakFor } from '../do-work/command.mjs';
import settings from '../do-work/command.json' with { type: 'json' };
import { recordStore, taskDoorOps } from '../test-fixtures/task-records.mjs';

// These tests speak for one site, as an install from that site's site makes the command do.
speakFor({ cli: 'example', site_name: 'Example' });

// An AG-UI agent written by hand, as the protocol's server starter writes one: each POST is one run. `script(input)`
// returns the events after RUN_STARTED; the inputs it was sent are kept.
async function agent(script) {
  const inputs = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const input = JSON.parse(body);
      inputs.push(input);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [{ type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId }, ...script(input)]) response.write(sseFrame(event));
      response.end();
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}/agent`, inputs, close: () => new Promise(done => server.close(done)) };
}

const finished = input => ({ type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId });
const say = (id, words) => [{ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: words }, { type: 'TEXT_MESSAGE_END', messageId: id }];
const ask = (id, name, args) => [{ type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name }, { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(args) }, { type: 'TOOL_CALL_END', toolCallId: id }];

// The example command's client, answering from an account's lists; every tool it runs is kept.
function client() {
  const ran = [];
  return {
    ran,
    rpc: async method => (method === 'tools/list' ? { tools: [
      { name: 'list_lists', description: 'The lists this person keeps.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } },
      { name: 'delete_file', description: 'Deletes a file.', inputSchema: { type: 'object' } },
    ] } : {}),
    tool: async (name, args) => { ran.push({ name, args }); if (name === 'list_lists') return { lists: [{ id: 'l1', name: 'Groceries' }, { id: 'l2', name: 'Reading' }] }; return {}; },
  };
}

const handoff = { handoff_id: 'h_abc', generation: 2, words: 'How many lists do I keep?' };

test('the agent asks for an offered tool, is given its answer, and its words are the result', async () => {
  const counted = await agent(input => (input.messages.at(-1).role === 'tool'
    ? [...say('m2', `You keep 2 lists: ${JSON.parse(input.messages.at(-1).content).lists.map(row => row.name).join(' and ')}.`), finished(input)]
    : [...say('m1', 'Checking.'), ...ask('c1', 'list_lists', { limit: 10 }), finished(input)]));
  const account = client();
  try {
    const answer = await runOnAgUi(counted.url, handoff, { client: account, rules: settings });
    assert.deepEqual(answer, { ok: true, output: 'You keep 2 lists: Groceries and Reading.' }, 'the last run\'s words are the result');
    assert.deepEqual(account.ran, [{ name: 'list_lists', args: { limit: 10 } }], 'the offered tool ran here, once, with the agent\'s arguments');
    const [first, second] = counted.inputs;
    assert.equal(first.threadId, 'h_abc');
    assert.equal(first.runId, 'h_abc:2:1');
    assert.deepEqual(first.messages.map(message => message.content), ['How many lists do I keep?'], 'the task\'s words are the user message');
    assert.deepEqual(first.tools.map(tool => tool.name), ['list_lists'], 'only tools named in DATA are offered');
    assert.match(first.context[0].value, /h_abc/);
    assert.deepEqual(second.messages.slice(1).map(message => message.role), ['assistant', 'assistant', 'tool'], 'the second run carries what the first said, its tool call and the answer');
    assert.equal(second.messages.at(-1).toolCallId, 'c1');
  } finally { await counted.close(); }
});

test('a tool the agent was not offered is never run, and an interrupt keeps the job with what is in the way', async () => {
  const pushy = await agent(input => (input.messages.at(-1).role === 'tool'
    ? [{ type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId, outcome: { type: 'interrupt', interrupts: [{ id: 'i1', reason: 'approval', message: 'May I delete the old drafts?' }] } }]
    : [...ask('c1', 'delete_file', { path: '/drafts' }), finished(input)]));
  const account = client();
  try {
    const answer = await runOnAgUi(pushy.url, handoff, { client: account, rules: settings });
    assert.deepEqual(answer, { ok: true, stuck: 'May I delete the old drafts?', output: 'May I delete the old drafts?' });
    assert.deepEqual(account.ran, [], 'delete_file was not offered, so nothing ran');
    assert.equal(pushy.inputs[1].messages.at(-1).content, settings.ag_ui.words.not_offered.replace('{tool}', 'delete_file'));
  } finally { await pushy.close(); }
});

const ACCEPTANCE = { outcome: 'Done', target: { type: 'note', id: 'note:1' }, rules: [{ id: 'outcome', path: 'text', equals: ['Done'] }] };
const TASK = 'record:calendar-task:abc';

/** One take of a waiting task, run through the task rows over an in-memory account; every call is kept in `calls`. */
const taskClient = (store, calls) => {
  const ops = taskDoorOps(store);
  return { wait: async () => {}, op: async (address, method, input) => {
    calls.push({ method, tool: input?.tool, action: input?.input?.action, id: input?.input?.id, as: input?.input?.as, continuation: input?.input?.continuation });
    const handler = ops[`${address ?? (method.startsWith('tools:') ? '@tools' : '')} ${method}`];
    const answer = await handler(input, { address, method });
    if (answer?.refused) throw new Error(answer.refused);
    return answer;
  } };
};

test('serveOnce records each way a run ends with the task row that makes that move', async () => {
  const me = { agent_id: 'ag-ui-mac', ai_id: 'ai:ag-ui-mac' };
  for (const [ran, action] of [[{ ok: true, output: 'Done', stuck: 'Which bank?' }, 'stuck'], [{ ok: true, output: 'Done', check: true }, 'finish'], [{ ok: true, output: 'Done' }, 'wait'], [{ ok: false, output: 'It failed' }, 'wait']]) {
    const store = recordStore([['ai:ag-ui-mac', 'ai', {}], ['note:1', 'note', { text: 'Done' }], [TASK, 'calendar-task', { title: 'List', outcome: 'Done', status: 'To do', sent_by: 'ai:someone', sent_at: '2026-11-19T12:00:00.000Z', priority: 'medium', acceptance: ACCEPTANCE }]]);
    const calls = [];
    const runImpl = async () => (ran.check ? { ...ran, check: { outcome: 'Done', checked_at: new Date().toISOString(), evidence: [{ ref: 'note:1', observation: 'Read back.' }], obligations: [] } } : ran);
    await serveOnce({ client: taskClient(store, calls), me, command: [], state: { hold: () => {}, letGo: () => {} }, log: () => {}, runImpl });
    const move = calls.filter(call => call.tool !== undefined).at(-1);
    assert.deepEqual([move.tool, move.action, move.id, move.as], [action === 'finish' ? settings.tasks.tools.finish : settings.tasks.tools.change, action, TASK, me.ai_id]);
    assert.equal(store.get(TASK).status, { stuck: 'In progress', finish: 'Done', wait: 'Waiting' }[action]);
    if (action === 'wait') assert.equal(move.continuation.reason, ran.ok ? 'The command returned successfully but supplied no complete consumer check receipt.' : ran.output, 'a run that cannot be checked is blocked on an owned next step');
  }
});

test('a run that never finishes, an agent that refuses, or too many tool runs give the job back with why', async () => {
  const silent = await agent(() => say('m1', 'half a thought'));
  const looping = await agent(input => [...ask(`c${input.runId}`, 'list_lists', {}), finished(input)]);
  try {
    assert.deepEqual(await runOnAgUi(silent.url, handoff, { client: client(), rules: settings }), { ok: false, output: 'The AG-UI agent\'s run failed: The agent ended its run without finishing it.' });
    assert.equal((await runOnAgUi('http://127.0.0.1:9/none', handoff, { client: client(), rules: settings })).ok, false);
    const capped = await runOnAgUi(looping.url, handoff, { client: client(), rules: { ...settings, ag_ui: { ...settings.ag_ui, max_turns: 3 } } });
    assert.deepEqual(capped, { ok: false, output: settings.ag_ui.words.too_many_turns.replace('{turns}', '3') });
    assert.equal(looping.inputs.length, 3);
  } finally { await silent.close(); await looping.close(); }
});

test('the wire reads frames split anywhere, skips comments and folds a run into messages', async () => {
  const frames = [': keep\n\n', sseFrame({ type: 'RUN_STARTED', threadId: 't', runId: 'r' }), sseFrame({ type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' }), sseFrame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'héllo' }), sseFrame({ type: 'RUN_FINISHED', threadId: 't', runId: 'r' })].join('');
  const bytes = new TextEncoder().encode(frames);
  const body = new ReadableStream({ start(stream) { for (let at = 0; at < bytes.length; at += 7) stream.enqueue(bytes.slice(at, at + 7)); stream.close(); } });
  const events = [];
  for await (const event of sseEvents(body)) events.push(event);
  assert.deepEqual(events.map(event => event.type), ['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'RUN_FINISHED']);
  const run = foldRun(events);
  assert.equal(run.text, 'héllo');
  assert.deepEqual(run.messages, [{ id: 'm', role: 'assistant', content: 'héllo' }]);
  assert.deepEqual(taskMessages({ handoff_id: 'h', words: 'j' }), [{ id: 'task:h', role: 'user', content: 'j' }]);
});

test('the wire bounds complete frames even when the frame and delimiter arrive in one read', async () => {
  const body = new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(sseFrame({ type: 'RUN_STARTED', payload: 'x'.repeat(80) }))); stream.close(); } });
  const events = [];
  await assert.rejects(async () => { for await (const event of sseEvents(body, { maxFrameChars: 64 })) events.push(event.type); }, /longer than 64 characters/);
  assert.deepEqual(events, [], 'an over-sized event is rejected before it is delivered');
});

test('the wire bounds an unfinished event and cancels its stream', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(stream) { stream.enqueue(new TextEncoder().encode('x'.repeat(20))); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(async () => { for await (const event of sseEvents(body, { maxFrameChars: 64 })) assert.fail('no complete event exists'); }, /longer than 64 characters/);
  assert.equal(cancelled, true);
});

test('the wire accepts an exact-limit frame with its CRLF separator split across reads', async () => {
  const frame = 'data: ' + JSON.stringify({ type: 'RUN_STARTED' });
  const body = new ReadableStream({ start(stream) {
    for (const chunk of [frame, '\r', '\n', '\r', '\n']) stream.enqueue(new TextEncoder().encode(chunk));
    stream.close();
  } });
  const events = [];
  for await (const event of sseEvents(body, { maxFrameChars: frame.length })) events.push(event.type);
  assert.deepEqual(events, ['RUN_STARTED']);
});

test('a run that breaks the protocol\'s order is an error, never half a result, and a silent agent is stopped', async () => {
  assert.match(foldRun([{ type: 'TEXT_MESSAGE_START', messageId: 'm' }]).error, /began with TEXT_MESSAGE_START/);
  assert.match(foldRun([{ type: 'RUN_STARTED' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'x', delta: 'hi' }, { type: 'RUN_FINISHED' }]).error, /never started/);
  assert.match(foldRun([{ type: 'RUN_STARTED' }, { type: 'RUN_FINISHED' }, { type: 'TEXT_MESSAGE_START', messageId: 'm' }]).error, /after its run ended/);
  assert.equal(foldRun([{ type: 'RUN_STARTED' }, { type: 'TEXT_MESSAGE_CHUNK', messageId: 'c', delta: 'chunks start themselves' }, { type: 'RUN_FINISHED' }]).text, 'chunks start themselves');
  // The Claude Agent SDK's AG-UI adapter echoes, on the next run, the answer it was given for a call of the run before.
  assert.equal(foldRun([{ type: 'RUN_STARTED' }, { type: 'TOOL_CALL_RESULT', toolCallId: 'earlier', messageId: 'r', content: '{}' }, { type: 'RUN_FINISHED' }]).error, null);
  assert.match(foldRun([{ type: 'RUN_STARTED' }, { type: 'TOOL_CALL_ARGS', toolCallId: 'never', delta: '{}' }, { type: 'RUN_FINISHED' }]).error, /never started/);
  const body = new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(sseFrame({ type: 'RUN_STARTED' }))); } });
  const seen = [];
  await assert.rejects(async () => { for await (const event of sseEvents(body, { quietMs: 50 })) seen.push(event.type); }, /sent nothing for 0 seconds/);
  assert.deepEqual(seen, ['RUN_STARTED'], 'what came before the silence was read');
});
