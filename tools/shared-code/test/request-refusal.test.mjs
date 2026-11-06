// Ported from old trillion test/request-refusal.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The two route tests are the old ones over src/agents.mjs and src/failure.mjs here,
// on the agents store tests use (test/agent-store-for-tests.mjs). The third test ran an AgentsError through
// handleMcpMessage (old src/tools.mjs), which is held, not run (tools/list-and-run-trillions-tools-for-any-ai/
// from-old-trillion/src/tools.mjs.held); no running code turns a JS tool's refusal into an MCP result, so it is left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentsError, handleAgentsRequest, makeAgents } from '../src/agents.mjs';
import { agentStoreForTests } from './agent-store-for-tests.mjs';
import { failureOf, failureFromReply } from '../src/failure.mjs';

const request = (path, body) => new Request(`https://person${path}`, { method: 'POST', body: JSON.stringify(body) });
test('unknown take and fenced finish refuse without changing the held job', async () => {
  const store = agentStoreForTests(), agents = makeAgents({ store });
  agents.publish({ agent_id: 'owner', name: 'Owner', description: 'Works' });
  const { handoff } = agents.handOff({ to_agent: 'owner', job: 'Check the result', request_key: 'fenced' });
  const taken = agents.take({ agent_id: 'owner', handoff_id: handoff.handoff_id }).handoff;
  const before = structuredClone(store.handoff(handoff.handoff_id));
  for (const [path, input] of [
    ['/handoffs/take', { agent_id: 'missing' }],
    ['/handoffs/finish', { agent_id: 'owner', handoff_id: handoff.handoff_id, generation: taken.generation + 1, result: 'must not finish' }],
  ]) {
    const response = await handleAgentsRequest(agents, request(path, input));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.failure_code, 'request-refused');
    assert.ok(body.error.length);
    assert.deepEqual(store.handoff(handoff.handoff_id), before);
  }
});

test('only explicit owner refusal gets the correction policy, regardless of platform words', async () => {
  const next = { tool: 'read_handoff', arguments: { handoff_id: 'fixture' } };
  const response = await handleAgentsRequest({ take: () => { throw new AgentsError('The service was busy is the supplied invalid name', next); } }, request('/handoffs/take', {}));
  const body = await response.json();
  assert.equal(body.failure_code, 'request-refused');
  assert.deepEqual(body.next_call, next);
  const policy = failureOf(failureFromReply(body.error, body));
  assert.equal(policy.code, 'request-refused');
  assert.equal(policy.retryable, false);
  assert.equal(policy.fatal, false);
  for (const error of [new Error('synthetic storage failure'), new SyntaxError('synthetic invalid payload')]) {
    await assert.rejects(handleAgentsRequest({ take: () => { throw error; } }, request('/handoffs/take', {})), cause => cause === error);
  }
  const malformed = await handleAgentsRequest({ take() { throw new Error('must not reach action'); } }, new Request('https://person/handoffs/take', { method: 'POST', body: '{' }));
  assert.equal(malformed.status, 400);
  const malformedBody = await malformed.json();
  assert.equal(malformedBody.failure_code, 'request-refused');
  for (const input of [null, [], true, 17, 'invalid']) {
    const response = await handleAgentsRequest({ take() { throw new Error('must not reach action'); } }, request('/handoffs/take', input));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).failure_code, 'request-refused');
  }
});
