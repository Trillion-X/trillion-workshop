import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

for (const size of [128, 512]) test(`work metadata reads only named agents among ${size} published cards`, () => {
  const backing = agentStoreForTests();
  let lists = 0, reads = [];
  // A named card is read alone (card) or with the others a page names (cardsById); either way each counts once.
  const store = { ...backing, cards: () => { lists += 1; return backing.cards(); }, card: id => { reads.push(id); return backing.card(id); },
    cardsById: ids => { reads.push(...ids); return backing.cardsById(ids); } };
  const agents = makeAgents({ store });
  for (let index = 0; index < size; index += 1) agents.publish({ agent_id: `ai-${index}`, name: `AI ${index}`, description: 'Unrelated published card' });
  agents.handOff({ job: 'One selected job', request_key: 'selected-work', from_agent: 'ai-0', to_agent: 'ai-1' });
  const check = page => {
    assert.deepEqual(new Set(page.agents.map(row => row.agent_id)), new Set(['ai-0', 'ai-1']));
    assert.equal(lists, 0, 'a work read never loads the whole agent directory');
    assert.deepEqual(new Set(reads), new Set(['ai-0', 'ai-1']));
    assert.equal(reads.length, 2, 'each named card is read once');
    lists = 0; reads = [];
  };
  lists = 0; reads = [];
  check(agents.board({ limit: 1, agent_scope: 'work' }));
  check(agents.recentWork({ limit: 1 }));
  check(agents.notificationWork({ limit: 1 }));
  assert.equal(agents.board({ limit: 1 }).agents.length, size, 'the explicit screen directory retains unrelated AIs');
});

test('work metadata with no jobs reads no published cards', () => {
  const backing = agentStoreForTests();
  const agents = makeAgents({ store: { ...backing, cards: () => { throw new Error('unrelated directory'); }, card: () => { throw new Error('unnamed card'); } } });
  assert.deepEqual(agents.board({ limit: 1, agent_scope: 'work' }).agents, []);
});
