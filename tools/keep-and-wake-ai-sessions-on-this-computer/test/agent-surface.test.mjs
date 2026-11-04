// Two-layer agent pairing (src/agents.mjs publish + decideSurface, DATA src/agent-surface.json): a card's first
// publication approves its skills; with approve_widening on, a later skill waits as pending_skills until another key
// than the agent's own approves it. Off (the default) a card is whatever its agent publishes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import agentSurface from '../../shared-code/src/agent-surface.json' with { type: 'json' };
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

const publish = (agents, skills, reader) => agents.publish({ agent_id: 'mac', name: 'Mac', description: 'Works on the Mac', takes_work: true, skills }, { reader }).agent;
const names = skills => skills.map(skill => skill.name);

test('with the default off a card is whatever the agent publishes', () => {
  assert.equal(agentSurface.approve_widening, false);
  const agents = makeAgents({ store: agentStoreForTests() });
  publish(agents, ['read files'], 'key-a');
  const card = publish(agents, ['read files', 'drive the screen'], 'key-a');
  assert.deepEqual(names(card.skills), ['read files', 'drive the screen']);
  assert.equal(card.pending_skills, undefined);
});

test('with widening approval on, new skills wait, the agent cannot approve its own, another key can, and refusing drops them', () => {
  agentSurface.approve_widening = true;
  try {
    const agents = makeAgents({ store: agentStoreForTests() });
    assert.deepEqual(names(publish(agents, ['read files'], 'key-a').skills), ['read files']);
    const widened = publish(agents, ['read files', 'drive the screen'], 'key-a');
    assert.deepEqual(names(widened.skills), ['read files']);
    assert.deepEqual(names(widened.pending_skills), ['drive the screen']);
    assert.throws(() => agents.decideSurface({ agent_id: 'mac', approve: true }, { reader: 'key-a' }), /cannot approve its own widening/);
    const approved = agents.decideSurface({ agent_id: 'mac', approve: true }, { reader: 'key-b' });
    assert.deepEqual(names(approved.agent.skills), ['read files', 'drive the screen']);
    assert.equal(approved.agent.pending_skills, undefined);
    assert.match(approved.said, /now offers drive the screen/);
    assert.throws(() => agents.decideSurface({ agent_id: 'mac', approve: true }, { reader: 'key-b' }), /no skills waiting/);
    // Narrowing is immediate; a refused skill is gone until it is published again.
    assert.deepEqual(names(publish(agents, ['read files'], 'key-a').skills), ['read files']);
    publish(agents, ['read files', 'camera'], 'key-a');
    const refused = agents.decideSurface({ agent_id: 'mac', approve: false }, { reader: 'key-b' });
    assert.deepEqual(names(refused.agent.skills), ['read files']);
    assert.match(refused.said, /will not offer camera/);
  } finally { agentSurface.approve_widening = false; }
});
