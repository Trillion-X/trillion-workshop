// test/ag-ui.test.mjs
//
// Trillion's work as AG-UI (src/ag-ui.mjs): a client's message hands a job to the person's AIs, the run streams the
// job's calls and ends when something is in the way (an interrupt) or the job finishes; the answer steers the same job.
// The job, its calls and who made them come from the real owners (src/agents.mjs over the test store, src/activity.mjs
// over SQLite, each call kept with its shipped activity mark), read the way the person's job screen reads them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { activityFor, activityRow, keepActivity } from '../../see-what-my-ais-did/activity.mjs';
import { AG_UI, AgUiInputError, eventStream, interruptIdOf, jobOfInterrupt, runInput, watchRun } from '../src/ag-ui.mjs';
import { sseFrame } from '../harness/ag-ui-wire.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

function sqlite() {
  const db = new DatabaseSync(':memory:');
  return { exec: (query, ...binds) => { const statement = db.prepare(query); const rows = /^\s*(?:select|explain)/i.test(query) ? statement.all(...binds) : (statement.run(...binds), []); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } };
}

// An account: the agents owner, its activity record, and the calls an app makes through them, each kept as the MCP road
// keeps it (activityRow with the shipped marks). `read` answers the run as src/native-resource-screen-behavior.mjs jobRun does.
function account() {
  const agents = makeAgents({ store: agentStoreForTests() });
  const sql = sqlite();
  const call = (app, tool, method, input) => {
    const result = agents[method](input);
    const row = activityRow({ tool, input, result, app, at: new Date().toISOString() });
    if (row) keepActivity(sql, row);
    return result;
  };
  const tools = { hand_off: 'handOff' };
  const tool = async (name, args) => call('AG-UI client', name, tools[name], args);
  const read = async path => {
    const handoff = new URL(path, 'https://x').searchParams.get('handoff');
    let jobs;
    try { jobs = agents.withParts(handoff); } catch { return null; }
    if (!jobs.length) return null;
    const steps = activityFor(sql, jobs.map(job => job.handoff_id));
    const ids = [...new Set(jobs.flatMap(job => [job.taken_by, ...(job.attempts ?? []).map(attempt => attempt.agent_id)]).filter(Boolean))];
    return { jobs, steps, actors: ids.map(id => ({ id, name: agents.cardOf(id)?.name ?? id })), progress: null };
  };
  agents.publish({ agent_id: 'mac-claude', name: 'Claude Code on the Mac', description: 'Does handed work', takes_work: true });
  const ai = {
    take: handoff_id => call('Claude Code', 'take_work', 'take', { agent_id: 'mac-claude', handoff_id }),
    inTheWay: (handoff_id, words) => call('Claude Code', 'say_what_is_in_the_way', 'sayInTheWay', { agent_id: 'mac-claude', handoff_id, in_the_way: words }),
    finish: (handoff_id, result, summary) => call('Claude Code', 'finish_work', 'finish', { agent_id: 'mac-claude', handoff_id, result, summary }),
    handOn: (parent_handoff_id, job) => call('Claude Code', 'hand_off', 'handOff', { job, request_key: `part:${job}`, parent_handoff_id, to_agent: 'codex' }),
  };
  agents.publish({ agent_id: 'codex', name: 'Codex', description: 'Takes parts', takes_work: true });
  ai.codex = {
    take: handoff_id => call('Codex', 'take_work', 'take', { agent_id: 'codex', handoff_id }),
    finish: (handoff_id, result, summary) => call('Codex', 'finish_work', 'finish', { agent_id: 'codex', handoff_id, result, summary }),
  };
  return { agents, tool, read, ai };
}

// The ordering rules an AG-UI client's verifier holds a run to (@ag-ui/client verify): RUN_STARTED first, a started
// text message, tool call or step closed before RUN_FINISHED, and nothing after the run ends.
function protocolProblems(events) {
  const problems = [];
  const open = { text: new Set(), tool: new Set(), step: new Set(), sub: new Set() };
  const owner = new Map();
  let ended = false;
  events.forEach((event, index) => {
    if (ended) problems.push(`${event.type} after the run ended`);
    if (index === 0 && event.type !== 'RUN_STARTED') problems.push('First event must be RUN_STARTED');
    if (event.type === 'TEXT_MESSAGE_START') open.text.add(event.messageId);
    if (event.type === 'TEXT_MESSAGE_CONTENT' && (!open.text.has(event.messageId) || !event.delta)) problems.push(`content without an open message ${event.messageId}`);
    if (event.type === 'TEXT_MESSAGE_END') open.text.delete(event.messageId);
    if (event.type === 'SUBAGENT_STARTED') { if (open.sub.has(event.subagentRunId)) problems.push(`subagent ${event.subagentRunId} started twice`); open.sub.add(event.subagentRunId); }
    if (event.type === 'SUBAGENT_FINISHED' || event.type === 'SUBAGENT_ERROR') { if (!open.sub.delete(event.subagentRunId)) problems.push(`subagent ${event.subagentRunId} ended without starting`); }
    if (event.type.startsWith('TOOL_CALL') && event.subagentRunId && !open.sub.has(event.subagentRunId)) problems.push(`${event.type} for subagent ${event.subagentRunId} that is not running`);
    if (event.type === 'TOOL_CALL_START') owner.set(event.toolCallId, event.subagentRunId ?? null);
    if (event.type.startsWith('TOOL_CALL') && event.type !== 'TOOL_CALL_START' && (owner.get(event.toolCallId) ?? null) !== (event.subagentRunId ?? null)) problems.push(`${event.type} owned by another subagent than its start`);
    if (event.type === 'TOOL_CALL_START') open.tool.add(event.toolCallId);
    if ((event.type === 'TOOL_CALL_ARGS' || event.type === 'TOOL_CALL_END') && !open.tool.has(event.toolCallId)) problems.push(`${event.type} without a started call`);
    if (event.type === 'TOOL_CALL_END') open.tool.delete(event.toolCallId);
    if (event.type === 'STEP_STARTED') open.step.add(event.stepName);
    if (event.type === 'STEP_FINISHED') { if (!open.step.delete(event.stepName)) problems.push(`step ${event.stepName} finished without starting`); }
    if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') {
      if (event.type === 'RUN_FINISHED' && (open.text.size || open.tool.size || open.step.size || open.sub.size)) problems.push(`RUN_FINISHED with open ${[...open.text, ...open.tool, ...open.step, ...open.sub].join(', ')}`);
      ended = true;
    }
  });
  if (!ended) problems.push('the run never ended');
  return problems;
}

// Runs one input to its end; `between` is what happens in the world each time the run waits for its next read.
async function collect(input, { tool, read }, between = []) {
  const events = [];
  let clock = 0;
  const wait = async ms => { clock += ms; const next = between.shift(); if (next) await next(); };
  for await (const event of watchRun(runInput(input), { tool, read, wait, now: () => clock })) events.push(event);
  return events;
}

test('a message hands a job, the run streams its calls, and what is in the way ends it as an interrupt the answer steers', async () => {
  const { agents, tool, read, ai } = account();
  const input = { threadId: 'thread-1', runId: 'run-1', messages: [{ id: 'm1', role: 'user', content: 'Book a table for four on Friday' }] };
  let handoff_id;
  const events = await collect(input, { tool, read }, [
    async () => { handoff_id = agents.read({}).handoffs[0].handoff_id; ai.take(handoff_id); },
    async () => { ai.inTheWay(handoff_id, 'Which restaurant: Nopa or Zuni?'); },
  ]);
  assert.deepEqual(protocolProblems(events), []);
  assert.equal(agents.read({}).handoffs.length, 1, 'one job for one message');
  assert.equal(agents.read({}).handoffs[0].job, 'Book a table for four on Friday');
  const calls = events.filter(event => event.type === 'TOOL_CALL_START').map(event => event.toolCallName);
  // say_what_is_in_the_way has no activity mark, so it is no step of its own: it shows as the interrupt and the state.
  assert.deepEqual(calls, ['hand_off', 'take_work'], 'every call kept for the job, oldest first, once each');
  assert.ok(events.some(event => event.type === 'STEP_STARTED' && event.stepName === `${handoff_id}:1`), 'the AI taking it is a step');
  const last = events.at(-1);
  assert.equal(last.type, 'RUN_FINISHED');
  assert.equal(last.outcome.type, 'interrupt');
  const [interrupt] = last.outcome.interrupts;
  assert.equal(interrupt.id, interruptIdOf(agents.read({ handoff_id }).handoff));
  assert.equal(jobOfInterrupt(interrupt.id), handoff_id);
  assert.equal(interrupt.message, 'Claude Code on the Mac says this is in the way: Which restaurant: Nopa or Zuni?', 'named by the run\'s own actors, in DATA words');
  const state = events.filter(event => event.type === 'STATE_SNAPSHOT').at(-1).snapshot;
  assert.equal(state.job.status, 'blocked');

  // The client answers: the answer is a steer of that same job; the AI finishes; the next run ends with the result.
  const held = [
    ...input.messages,
    { id: 'a1', role: 'assistant', toolCalls: events.filter(event => event.type === 'TOOL_CALL_START').map(event => ({ id: event.toolCallId, type: 'function', function: { name: event.toolCallName, arguments: '{}' } })) },
    ...events.filter(event => event.type === 'TOOL_CALL_RESULT').map(event => ({ id: event.messageId, role: 'tool', toolCallId: event.toolCallId, content: event.content })),
  ];
  const resumed = await collect({ threadId: 'thread-1', runId: 'run-2', messages: held, resume: [{ interruptId: interrupt.id, status: 'resolved', payload: 'Zuni, 7 pm' }] }, { tool, read }, [
    async () => { ai.finish(handoff_id, 'Booked Zuni for four, Friday 7 pm. Confirmation 4417.', 'Booked'); },
  ]);
  assert.deepEqual(protocolProblems(resumed), []);
  const steered = agents.read({ handoff_id }).handoff;
  assert.deepEqual(steered.steers.map(steer => steer.job), ['Zuni, 7 pm'], 'the answer is kept on the job, once');
  assert.equal(agents.read({}).handoffs.length, 1, 'no second job');
  assert.deepEqual(resumed.filter(event => event.type === 'TOOL_CALL_START').map(event => event.toolCallName), ['hand_off', 'finish_work'], 'calls the client holds are not sent again; the steer and the finish are');
  assert.equal(resumed.find(event => event.type === 'TEXT_MESSAGE_CONTENT').delta, 'Booked\n\nBooked Zuni for four, Friday 7 pm. Confirmation 4417.');
  assert.deepEqual(resumed.at(-1).outcome, { type: 'success' });

  // The same answer sent again keeps one steer and is not interrupted again by what it answered.
  await collect({ threadId: 'thread-1', runId: 'run-3', messages: held, resume: [{ interruptId: interrupt.id, status: 'resolved', payload: 'Zuni, 7 pm' }] }, { tool, read });
  assert.equal(agents.read({ handoff_id }).handoff.steers.length, 1);
});

test('the same message run again watches the same job; a later message steers it while it runs', async () => {
  const { agents, tool, read, ai } = account();
  const first = { threadId: 'thread-2', runId: 'run-1', messages: [{ id: 'm1', role: 'user', content: 'Summarise the board deck' }] };
  await collect(first, { tool, read }, [async () => { ai.take(agents.read({}).handoffs[0].handoff_id); }]);
  await collect({ ...first, runId: 'run-2' }, { tool, read });
  assert.equal(agents.read({}).handoffs.length, 1, 'a reconnect never hands the job twice');
  const job = agents.read({}).handoffs[0];
  await collect({ threadId: 'thread-2', runId: 'run-3', messages: [...first.messages, { id: 'm2', role: 'user', content: 'Keep it to one page' }] }, { tool, read });
  assert.deepEqual(agents.read({ handoff_id: job.handoff_id }).handoff.steers.map(steer => steer.job), ['Keep it to one page']);
  assert.equal(agents.read({}).handoffs.length, 1);
});

test('a thread can watch a job another AI handed, drawn from its first read, and a watch that runs out asks to be run again', async () => {
  const { agents, tool, read, ai } = account();
  const { handoff } = agents.handOff({ job: 'Reconcile the March invoices', request_key: 'from-codex' });
  ai.take(handoff.handoff_id);
  const events = await collect({ threadId: handoff.handoff_id, runId: 'watch-1', messages: [] }, { tool, read }, Array.from({ length: 2000 }, () => async () => {}));
  assert.deepEqual(protocolProblems(events), []);
  assert.deepEqual(events.slice(1, 4).map(event => event.type), ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END']);
  assert.equal(events[1].role, 'user');
  assert.equal(events[2].delta, 'Reconcile the March invoices');
  assert.equal(events.at(-1).type, 'RUN_ERROR');
  assert.equal(events.at(-1).code, 'watch_ended');
  assert.equal(events.at(-1).message, AG_UI.words.watch_ended);
  assert.equal(agents.read({}).handoffs.length, 1, 'watching never hands work');
});

test('a part handed on from the job is a subagent of the run, with its own calls, closed before the run ends', async () => {
  const { agents, tool, read, ai } = account();
  let root, part;
  const events = await collect({ threadId: 'thread-5', runId: 'run-1', messages: [{ id: 'm1', role: 'user', content: 'Ship the release notes' }] }, { tool, read }, [
    async () => { root = agents.read({}).handoffs.find(job => !job.parent_handoff_id).handoff_id; ai.take(root); },
    async () => { part = ai.handOn(root, 'Draft the changelog section').handoff.handoff_id; },
    async () => { ai.codex.take(part); ai.codex.finish(part, 'Changelog drafted', 'Drafted'); },
    async () => { ai.finish(root, 'Release notes shipped', 'Shipped'); },
  ]);
  assert.deepEqual(protocolProblems(events), []);
  const started = events.find(event => event.type === 'SUBAGENT_STARTED');
  assert.deepEqual([started.subagentRunId, started.name], [part, 'Draft the changelog section']);
  const theirs = events.filter(event => event.type === 'TOOL_CALL_START' && event.subagentRunId === part).map(event => event.toolCallName);
  assert.deepEqual(theirs, ['take_work', 'finish_work'], 'the part\'s own calls are attributed to it');
  assert.equal(events.find(event => event.type === 'TOOL_CALL_START' && event.toolCallName === 'hand_off' && event.toolCallId !== events.find(first => first.type === 'TOOL_CALL_START').toolCallId).subagentRunId, undefined, 'the hand_off that made the part is the parent\'s');
  assert.deepEqual(events.find(event => event.type === 'SUBAGENT_FINISHED').outcome, { type: 'success' });
  assert.deepEqual(events.at(-1).outcome, { type: 'success' });
});

test('a part still running when the run ends is closed as suspended', async () => {
  const { agents, tool, read, ai } = account();
  let root;
  const events = await collect({ threadId: 'thread-6', runId: 'run-1', messages: [{ id: 'm1', role: 'user', content: 'Plan the offsite' }] }, { tool, read }, [
    async () => { root = agents.read({}).handoffs[0].handoff_id; ai.take(root); ai.handOn(root, 'Find a venue'); },
    async () => { ai.inTheWay(root, 'Which week?'); },
  ]);
  assert.deepEqual(protocolProblems(events), []);
  assert.deepEqual(events.filter(event => event.type === 'SUBAGENT_FINISHED').map(event => event.outcome), [{ type: 'suspended' }]);
  assert.equal(events.at(-1).outcome.type, 'interrupt');
});

test('a withdrawn job ends the run as cancelled', async () => {
  const { agents, tool, read } = account();
  const input = { threadId: 'thread-4', runId: 'run-1', messages: [{ id: 'm1', role: 'user', content: 'Draft the newsletter' }] };
  const events = await collect(input, { tool, read }, [async () => {
    const job = agents.read({}).handoffs[0];
    agents.withdrawWaiting({ handoff_id: job.handoff_id, revision: job.revision, reason: 'Not needed now', agent_id: 'mac-claude' }, { person: true });
  }]);
  assert.deepEqual(protocolProblems(events), []);
  assert.deepEqual(events.at(-1).outcome, { type: 'cancelled' });
});

test('input is checked and bounded before anything is read or written', async () => {
  assert.throws(() => runInput({ runId: 'r', messages: [] }), AgUiInputError);
  assert.throws(() => runInput({ threadId: 't', runId: 'r', messages: Array.from({ length: AG_UI.max_messages + 1 }, (_, n) => ({ id: `${n}`, role: 'user', content: 'x' })) }), AgUiInputError);
  assert.throws(() => runInput({ threadId: 't', runId: 'r', messages: [{ id: 'm', role: 'user', content: 'x'.repeat(AG_UI.max_message_chars + 1) }] }), AgUiInputError);
  assert.throws(() => runInput({ threadId: 't', runId: 'r', messages: [], resume: [{ interruptId: 'x', status: 'maybe' }] }), AgUiInputError);
  const { tool, read, agents } = account();
  const events = await collect({ threadId: 't', runId: 'r', messages: [], resume: [{ interruptId: 'not-ours', status: 'resolved' }] }, { tool, read });
  assert.deepEqual(events.map(event => event.type), ['RUN_STARTED', 'RUN_ERROR']);
  assert.equal(events[1].code, 'input');
  assert.equal(agents.read({}).handoffs.length, 0);
  assert.equal(runInput({ threadId: 't', runId: 'r', messages: [{ id: 'm', role: 'user', content: [{ type: 'text', text: 'parts' }] }] }).messages[0].text, 'parts');
});

test('events leave as AG-UI server-sent events, and a client that goes away stops the run', async () => {
  assert.match(sseFrame({ type: 'RUN_STARTED', threadId: 't', runId: 'r' }), /^data: \{"type":"RUN_STARTED","threadId":"t","runId":"r","timestamp":\d+\}\n\n$/);
  let stopped = false;
  async function* run() { try { yield { type: 'RUN_STARTED', threadId: 't', runId: 'r' }; await new Promise(() => {}); } finally { stopped = true; } }
  const controller = new AbortController();
  const response = eventStream(run(), controller);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /RUN_STARTED/);
  await reader.cancel();
  assert.equal(controller.signal.aborted, true);
  assert.equal(stopped || controller.signal.aborted, true);
});
