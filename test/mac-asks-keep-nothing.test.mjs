// test/mac-asks-keep-nothing.test.mjs
// A question Trillion puts to the model on the person's computer and waits for in the same instance (src/workshop.mjs
// askInMemory) is handed in memory (src/agents.mjs invariants): its event goes down the agent's live stream, and its
// take, finish and ack write nothing. About forty a minute on one account each wrote a whole job, its delivery, its
// notice, take, finish and ack, the store's largest writer on 2026-10-08. A kept run still keeps everything.
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { importSource } from 'trillion-workshop/test-helpers/import-source-for-tests.mjs';

// The current agent owner imports Workshop TypeScript. Bundle the actual owners in memory because Node cannot
// strip types from packages in node_modules; keep all three exports in one bundle so they share module state.
const root = fileURLToPath(new URL('..', import.meta.url));
const owner = path => JSON.stringify(fileURLToPath(import.meta.resolve(`trillion-workshop/tools/${path}`)));
const owners = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  export { makeAgents } from ${owner('shared-code/src/agents.mjs')};
  export { agentStoreForTests } from ${owner('shared-code/test/agent-store-for-tests.mjs')};
  export { runOnAgent } from ${owner('hand-off-jobs-between-agents/src/agent-tool-runs.mjs')};
` }, bundle: true, write: false, format: 'esm', platform: 'node' });
const { makeAgents, agentStoreForTests, runOnAgent } = await importSource(owners.outputFiles[0].text);

function account({ live = true } = {}) {
  const store = agentStoreForTests();
  const writes = [];
  for (const name of Object.keys(store).filter(name => /^put/.test(name))) {
    const write = store[name];
    store[name] = (...args) => { writes.push(name); return write(...args); };
  }
  const sent = [], told = [], nudges = [];
  const agents = makeAgents({ store, tell: said => told.push(said), stream: { send: (agent_id, event) => { sent.push(event); return live; }, live: () => live, nudge: () => nudges.push(1) } });
  agents.publish({ agent_id: 'mac', name: 'Tools on this Mac', description: 'Runs the tools this computer keeps.', takes_work: true, delivery: { stream: true } });
  writes.length = 0;
  return { agents, writes, sent, told, nudges };
}
const placement = { label: 'Your Mac', settings: { agent_id: 'mac', wait_seconds: 110 } };
const tool = { id: 'tool:ask', label: 'Ask the model on my Mac' };

// The Mac's side: it hears the event, takes the work by name, acks the event and finishes with the answer.
function answer(agents, sent) {
  const event = sent.at(-1);
  const handoff_id = event.subject_id ?? event.refs?.handoff_id;
  const { handoff, generation } = agents.take({ agent_id: 'mac', handoff_id, only_mine: true });
  assert.ok(handoff, 'the Mac takes the question it was told of');
  agents.ack({ event_id: event.event_id, agent_id: 'mac', ok: true });
  agents.finish({ handoff_id, agent_id: 'mac', generation, result: { verdict: { noul: 0.9 } } });
}

test('a question asked in memory is answered with nothing written', async () => {
  const { agents, writes, sent } = account();
  const asked = runOnAgent({ agents, placement, tool, invocation: {}, input: { state: 'words' }, task: { task_id: 'ask_1', in_memory: true }, every_ms: 5, wait_ms: 5000 });
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(sent.length, 1, 'the question goes down the stream at once');
  answer(agents, sent);
  assert.deepEqual(await asked, { verdict: { noul: 0.9 } });
  assert.deepEqual(writes, [], 'no job, delivery, notice, take, finish or ack is kept');
});

test('the queue offers an in-memory question by priority, then age, beside kept work', () => {
  const { agents } = account();
  agents.handOff({ job: 'Kept background run', to_agent: 'mac', from_agent: 'trillion-workshop', request_key: 'kept-1' });
  const urgent = agents.handOff({ job: 'Ask', to_agent: 'mac', from_agent: 'trillion-workshop', request_key: 'ask-2', priority: 3, take_within_seconds: 60, in_memory: true }).handoff;
  assert.equal(agents.take({ agent_id: 'mac', only_mine: true }).handoff.handoff_id, urgent.handoff_id);
  assert.equal(agents.take({ agent_id: 'mac', only_mine: true }).handoff.job, 'Kept background run');
});

test('a kept run is kept as before', async () => {
  const { agents, writes, sent } = account();
  const ran = runOnAgent({ agents, placement, tool, invocation: {}, input: {}, task: { task_id: 'task_1' }, every_ms: 5, wait_ms: 5000 });
  await new Promise(resolve => setTimeout(resolve, 1));
  answer(agents, sent);
  await ran;
  assert.ok(writes.includes('putHandoff'), 'the job is kept');
});

test('a question with no live stream is kept in memory, nudges the account once, and is takeable with nothing told', async () => {
  const { agents, writes, sent, told, nudges } = account({ live: false });
  const ran = runOnAgent({ agents, placement, tool, invocation: {}, input: {}, task: { task_id: 'ask_2', in_memory: true }, every_ms: 5, wait_ms: 5000 });
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(sent.length, 0, 'no stream is listening, so nothing goes down one');
  assert.deepEqual(nudges, [1], 'the account is nudged once for the question');
  assert.deepEqual(writes, [], 'the question is kept in memory, not as a job');
  const { handoff, generation } = agents.take({ agent_id: 'mac', only_mine: true });
  assert.ok(handoff, 'the Mac takes the question it was nudged about');
  agents.finish({ handoff_id: handoff.handoff_id, agent_id: 'mac', generation, result: { verdict: { noul: 0.9 } } });
  assert.deepEqual(await ran, { verdict: { noul: 0.9 } });
  assert.deepEqual(told, [], 'no notice is told about the question');
  assert.deepEqual(writes, [], 'its take and finish write nothing');
});
