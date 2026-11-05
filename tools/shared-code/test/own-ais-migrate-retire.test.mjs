// Ported from old trillion test/own-ais-migrate-retire.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted
// by Trillion-X/trillion #243. The retirement step of the old person store's migrateOwnAis: a published card of the earlier
// always-on harness that no ai row names stops taking work, and a card that an ai row names is left as it is. The old person
// store (test/person-store-reads-for-tests.mjs personStoreOver) went with the Worker; what it composed runs here: the agents
// (src/agents.mjs over test/agent-store-for-tests.mjs), the person's AIs (tools/see-and-limit-what-each-ai-can-reach
// src/ais.mjs makeAis, a published card kept as one of them and a retired card not listed, as the old store's agents() did)
// and the decision src/own-ais.mjs retiring makes.
// migrateOwnAis below applies that decision as old src/person-store.mjs did (its lines 1987-1996 at the tag: republish each
// retiring card with takes_work false, remove its row, then the rows only its cards made). Every assertion is the old one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { openRecords } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { makeAis } from '../../see-and-limit-what-each-ai-can-reach/src/ais.mjs';
import { makeAgents } from '../src/agents.mjs';
import { retiredHarness, retiring } from '../src/own-ais.mjs';
import settings from '../src/own-ais.json' with { type: 'json' };
import { agentStoreForTests } from './agent-store-for-tests.mjs';

const card = (agent_id, harness) => ({ agent_id, name: agent_id, description: 'A taker card', harness, takes_work: true,
  capacity: { max_concurrent: 1, ttl_minutes: 60 } });

// The parts of the old person store this step used.
function person() {
  const host = sqliteHost(':memory:');
  const ais = makeAis({ eeaf: openRecords(host.sql, { transaction: host.transaction }) });
  const underlying = agentStoreForTests();
  // A published agent card is one of the person's AIs (src/ais.mjs fromCard), as the old store's putCard kept it.
  const store = { ...underlying, putCard: item => { try { return underlying.putCard(item); } finally { const input = item?.agent_id ? ais.fromCard(item) : null; if (input) ais.upsert(input, { actor: { by: 'ais' } }); } } };
  // A card of the earlier harness that stopped taking work is not one of the person's AIs (the old store's `listed`).
  const agents = makeAgents({ store, listed: item => !(item.harness === retiredHarness() && item.takes_work === false) });
  const plain = agents;
  async function migrateOwnAis() {
    const named = new Set(ais.list().filter(row => ais.get(row.agent_id)?.id !== row.id).map(row => row.agent_id));
    const { cards, rows } = retiring(store.cards(), ais, named);
    const own = new Set(cards.map(item => item.agent_id));
    for (const item of cards) {
      plain.publish({ agent_id: item.agent_id, name: item.name, description: item.description, harness: item.harness, model: item.model ?? null, takes_work: false });
      ais.remove(item.agent_id, { actor: { by: 'own-ais' } });
    }
    for (const key of rows) if (!own.has(key)) ais.remove(key, { actor: { by: 'own-ais' } });
  }
  return { agents: () => agents, aisOf: () => ais, migrateOwnAis };
}

test('a retired-harness card that no ai row names stops taking work, and one an ai row names is untouched', async () => {
  const p = person();
  const agents = p.agents();
  const named = `${settings.agent_id_prefix}named`, unnamed = 'earlier-backup-ai', other = 'another-harness-card';
  agents.publish(card(named, settings.legacy.harness));
  agents.publish(card(unnamed, settings.legacy.harness));
  agents.publish(card(other, 'something-else'));
  p.aisOf().upsert({ key: 'named', label: 'Named', kind: 'chat', agent_id: named, order: 0, can: [...settings.kinds.chat.can],
    live: { seen_at: new Date().toISOString(), how: 'test' }, runs_on: { device: null, place: 'cloud' } }, { actor: { by: 'test' } });
  const takes = id => agents.cardOf(id).takes_work;
  assert.deepEqual([named, unnamed, other].map(takes), [true, true, true]);
  // A card that is no computer's is one chat of the AI that published it (src/ais.mjs fromCard): the earlier harness's
  // cards are one chat row named after it, listed among the person's AIs until they are retired.
  const harnessRow = `ai:${settings.legacy.harness}`;
  assert.ok(p.aisOf().list().some(ai => ai.id === harnessRow), 'the earlier harness\'s cards are one of the person\'s AIs until they are retired');
  assert.ok(p.aisOf().list().some(ai => ai.id === 'ai:something-else'));
  await p.migrateOwnAis();
  assert.equal(takes(unnamed), false, 'the card no ai row names stops taking work');
  assert.equal(p.aisOf().get(unnamed), null, 'and it is no longer one of the person\'s AIs');
  assert.equal(p.aisOf().list().some(ai => ai.id === harnessRow), false, 'the chat row only its cards made goes with them');
  assert.ok(p.aisOf().list().some(ai => ai.id === 'ai:something-else'), 'a chat row of another harness stays');
  assert.deepEqual(agents.find({ all: true }).agents.map(agent => agent.agent_id).sort(), [named, other].sort(), 'find_agents no longer lists it');
  assert.equal(p.aisOf().list().some(ai => ai.agent_id === named && ai.id !== 'ai:named'), false, 'a card an AI published under its own id makes no second row');
  assert.equal(takes(named), true, 'the card an ai row names is untouched');
  assert.equal(takes(other), true, 'a card of another harness is untouched');
  assert.equal(await p.migrateOwnAis().then(() => takes(named)), true, 'running again changes nothing');
});
