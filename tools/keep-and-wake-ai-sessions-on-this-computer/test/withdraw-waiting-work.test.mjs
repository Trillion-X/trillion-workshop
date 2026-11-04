import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents, agentTools, handleAgentsRequest, statusOf } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

function fixture() {
  let instant = Date.parse('2026-10-07T12:00:00Z');
  const store = agentStoreForTests(), completions = [];
  const agents = makeAgents({ store, now: () => new Date(instant), onFinished: item => completions.push(item) });
  agents.publish({ agent_id: 'sender', name: 'Sender', description: 'Asks for work' }, { reader: 'app:sender' });
  agents.publish({ agent_id: 'runner', name: 'Runner', description: 'Does work' }, { reader: 'app:runner' });
  let sequence = 0;
  const job = extra => agents.handOff({ request_key: `withdraw-test:${++sequence}`, job: 'A requested task', from_agent: 'sender', ...extra }, { reader: 'app:sender' }).handoff;
  const input = row => ({ handoff_id: row.handoff_id, agent_id: 'sender', revision: row.revision, reason: 'This waiting task is no longer needed.' });
  const post = async (body, reader = 'app:sender') => {
    const response = await handleAgentsRequest(agents, new Request('https://person/handoffs/withdraw-waiting', { method: 'POST', headers: { 'content-type': 'application/json', ...(reader ? { 'x-trillion-reader': reader } : {}) }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  const tool = agentTools(async (path, body) => {
    assert.equal(path, '/handoffs/withdraw-waiting');
    const reply = await post(body);
    if (reply.status !== 200) throw new Error(reply.body.error);
    return reply.body;
  }).find(item => item.name === 'withdraw_waiting_work');
  return { store, agents, job, input, post, tool, completions, advance: minutes => { instant += minutes * 60000; } };
}

test('MCP reaches the same guarded route and preserves a distinct, idempotent withdrawal', async () => {
  const f = fixture(), row = f.job({ input: { arrived: { message_id: 'message:withdrawal' } } });
  assert.ok(f.tool, 'the operation is actually advertised');
  const done = await f.tool.run(f.input(row));
  assert.equal(done.handoff.handoff_id, row.handoff_id);
  assert.equal(done.handoff.state, 'finished');
  assert.equal(done.handoff.status, 'withdrawn');
  assert.equal(done.handoff.result.state, 'withdrawn');
  assert.equal(done.handoff.next_step, null);
  assert.equal(done.handoff.revision, row.revision + 1);
  assert.equal(f.completions.length, 0, 'withdrawal never completes a decision/review step');
  const repeated = await f.tool.run(f.input(row));
  assert.equal(repeated.repeated, true);
  assert.equal(repeated.handoff.revision, done.handoff.revision);
  assert.equal(f.agents.take({ agent_id: 'runner', handoff_id: row.handoff_id }).handoff, null);
});

test('route rejects forged sender, reader, person context, missing authentication and another account', async () => {
  const f = fixture(), row = f.job(), before = f.store.handoff(row.handoff_id);
  for (const [extra, reader] of [[{ agent_id: 'runner' }, 'app:sender'], [{}, 'app:runner'], [{ person: true }, 'app:runner'], [{}, null]]) {
    const reply = await f.post({ ...f.input(row), ...extra }, reader);
    assert.equal(reply.status, 400); assert.match(reply.body.error, /authenticated sender/);
    assert.deepEqual(f.store.handoff(row.handoff_id), before);
  }
  const other = fixture();
  const absent = await other.post(f.input(row));
  assert.equal(absent.status, 400); assert.match(absent.body.error, /No handoff/);
});

test('republishing the sender card does not change the original authenticated reader', async () => {
  const f = fixture(), row = f.job();
  f.agents.publish({ agent_id: 'sender', name: 'Different app', description: 'Reuses a name' }, { reader: 'app:runner' });
  assert.equal((await f.post(f.input(row), 'app:runner')).status, 400);
  assert.equal((await f.post(f.input(row), 'app:sender')).status, 200);
});

test('stale revisions refuse without mutation; rereading permits a deliberate retry', async () => {
  const f = fixture(), row = f.job({ to_agent: 'runner' });
  f.agents.sayInTheWay({ handoff_id: row.handoff_id, agent_id: 'runner', in_the_way: 'Waiting on a resource' });
  const before = f.store.handoff(row.handoff_id);
  const stale = await f.post(f.input(row));
  assert.equal(stale.status, 400); assert.match(stale.body.error, /changed since/);
  assert.deepEqual(f.store.handoff(row.handoff_id), before);
  assert.equal((await f.post(f.input(f.agents.read({ handoff_id: row.handoff_id }).handoff))).status, 200);
});

test('taken work stays with its holder, even after its hold expires', async () => {
  const f = fixture(), row = f.job();
  f.agents.take({ agent_id: 'runner', handoff_id: row.handoff_id });
  for (const elapsed of [0, 1000]) {
    f.advance(elapsed);
    const current = f.agents.read({ handoff_id: row.handoff_id }).handoff;
    const reply = await f.post(f.input(current));
    assert.equal(reply.status, 400); assert.match(reply.body.error, /Only waiting work/);
    assert.equal(f.store.handoff(row.handoff_id).state, 'taken');
  }
});

test('unknown effects cannot be hidden by withdrawing released work', async () => {
  const f = fixture(), row = f.job();
  const taken = f.agents.take({ agent_id: 'runner', handoff_id: row.handoff_id }).handoff;
  f.agents.recordEffect({ handoff_id: row.handoff_id, agent_id: 'runner', generation: taken.generation, effect_id: 'write:one', state: 'starting' });
  const released = f.agents.release({ handoff_id: row.handoff_id, agent_id: 'runner', generation: taken.generation }).handoff;
  const before = f.store.handoff(row.handoff_id), reply = await f.post(f.input(released));
  assert.equal(reply.status, 400); assert.match(reply.body.error, /Effect write:one is unknown/);
  assert.deepEqual(f.store.handoff(row.handoff_id), before);
});

test('unfinished descendants behind a finished child refuse without changing any job', async () => {
  const f = fixture(), parent = f.job(), child = f.job({ parent_handoff_id: parent.handoff_id });
  const grandchild = f.job({ parent_handoff_id: child.handoff_id });
  // Seed a legacy incorrectly finished child: the closure owner now refuses this state itself.
  f.store.putHandoff({ ...f.store.handoff(child.handoff_id), state: 'finished', result: 'Earlier internal retirement' });
  const reply = await f.post(f.input(parent));
  assert.equal(reply.status, 400); assert.match(reply.body.error, /unfinished parts/);
  assert.equal(reply.body.next_call.arguments.handoff_id, grandchild.handoff_id);
  assert.equal(f.store.handoff(parent.handoff_id).state, 'open');
  assert.equal(f.store.handoff(grandchild.handoff_id).state, 'open');
});

test('checking an unknown effect and releasing permits a fresh withdrawal without replaying the effect', async () => {
  const f = fixture(), row = f.job();
  const first = f.agents.take({ agent_id: 'runner', handoff_id: row.handoff_id }).handoff;
  f.agents.recordEffect({ handoff_id: row.handoff_id, agent_id: 'runner', generation: first.generation, effect_id: 'write:checked', state: 'starting' });
  f.agents.release({ handoff_id: row.handoff_id, agent_id: 'runner', generation: first.generation });
  const checking = f.agents.take({ agent_id: 'runner', handoff_id: row.handoff_id }).handoff;
  f.agents.recordEffect({ handoff_id: row.handoff_id, agent_id: 'runner', generation: checking.generation, effect_id: 'write:checked', state: 'failed', receipt: { checked: 'Target has no write' } });
  const released = f.agents.release({ handoff_id: row.handoff_id, agent_id: 'runner', generation: checking.generation }).handoff;
  assert.equal((await f.post(f.input(released))).status, 200);
  assert.equal(f.store.handoff(row.handoff_id).effects['write:checked'].tries, 1);
  assert.equal(f.store.handoff(row.handoff_id).effects['write:checked'].state, 'failed');
});

test('a completed result cannot be relabeled as withdrawal', async () => {
  const f = fixture(), row = f.job();
  const taken = f.agents.take({ agent_id: 'runner', handoff_id: row.handoff_id }).handoff;
  const finished = f.agents.finish({ handoff_id: row.handoff_id, agent_id: 'runner', generation: taken.generation, result: 'The requested outcome was checked.' }).handoff;
  const reply = await f.post(f.input(finished));
  assert.equal(reply.status, 400); assert.match(reply.body.error, /Only waiting work/);
  assert.equal(f.store.handoff(row.handoff_id).result, 'The requested outcome was checked.');
});

test('unfinished dependents refuse rather than treating withdrawal as their prerequisite success', async () => {
  const f = fixture(), prerequisite = f.job(), dependent = f.job({ depends_on: [prerequisite.handoff_id] });
  const reply = await f.post(f.input(prerequisite));
  assert.equal(reply.status, 400); assert.match(reply.body.error, /depends on this result/);
  assert.equal(reply.body.next_call.arguments.handoff_id, dependent.handoff_id);
  assert.equal(f.store.handoff(prerequisite.handoff_id).state, 'open');
});

test('signed-in person context can withdraw legacy waiting work with no reader proof, but MCP cannot', async () => {
  const f = fixture();
  const row = f.agents.handOff({ job: 'Legacy internal request', request_key: 'legacy' }).handoff;
  assert.equal((await f.post(f.input(row))).status, 400);
  const done = f.agents.withdrawWaiting({ handoff_id: row.handoff_id, revision: row.revision, reason: 'The account owner withdraws this request.' }, { person: true });
  assert.equal(done.handoff.withdrawal.by, 'you');
  assert.equal(statusOf(f.store.handoff(row.handoff_id)), 'withdrawn');
});

test('incorrect-finish recovery cannot resume an intentional withdrawal', async () => {
  const f = fixture(), row = f.job();
  await f.post(f.input(row));
  assert.throws(() => f.agents.reopenIncorrectFinish({ handoff_id: row.handoff_id, evidence: 'A completion was unverified' }), /explicitly withdrawn/);
  assert.equal(f.store.handoff(row.handoff_id).state, 'finished');
  assert.equal((await f.post({ ...f.input(row), reason: 'A different reason' })).status, 400);
});
