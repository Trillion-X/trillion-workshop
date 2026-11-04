// test/saved-instruction-provenance.test.mjs
// A saved instruction records who wrote it; with the opt-in flag an AI's row waits as proposed until the person keeps it (F-0174).
import assert from 'node:assert/strict';
import test from 'node:test';
import { instructionsInTreeOrder, makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

const build = () => makeAgents({ store: agentStoreForTests(), now: () => new Date('2026-10-19T10:00:00Z'), starters: [] });

test('each row records the class of whoever wrote it and keeps it while its words stand', () => {
  const agents = build();
  agents.instructions({ instructions: [{ id: 'mine', label: 'Mine', words: 'Summarise it' }] });
  const second = agents.instructions({ instructions: [{ id: 'mine', label: 'Mine', words: 'Summarise it' }, { id: 'theirs', label: 'Theirs', words: 'Do a thing' }] }, { reader: 'key:abc' });
  const byId = Object.fromEntries(second.instructions.map(row => [row.id, row]));
  assert.equal(byId.mine.origin, undefined);
  assert.equal(byId.theirs.origin.class, 'agent');
  assert.equal(byId.theirs.origin.by, 'key:abc');
  assert.equal(byId.theirs.proposed, undefined);
  const edited = agents.instructions({ instructions: [{ id: 'mine', label: 'Mine', words: 'Summarise it differently' }, { id: 'theirs', label: 'Theirs', words: 'Do a thing' }] }, { reader: 'app:Claude Code' });
  assert.equal(edited.instructions[0].origin.class, 'agent');
  assert.equal(edited.instructions[1].origin.by, 'key:abc');
  console.log('readback', JSON.stringify(edited.instructions.map(row => [row.id, row.origin.class, row.origin.by])));
});

test('with agent rows starting proposed, an AI row is left out of the picks until the person keeps it', async () => {
  const { stampOrigins } = await import('../../shared-code/src/agents.mjs');
  const rules = { default_class: 'person', reader_classes: [{ reader_prefix: 'key:', class: 'agent' }], agent_rows_start_proposed: true };
  const now = '2026-10-19T10:00:00Z';
  const baseline = [{ id: 'mine', label: 'Mine', words: 'Summarise it', origin: { class: 'person', by: null, at: now } }];
  const written = [{ id: 'mine', label: 'Mine', words: 'Summarise it' }, { id: 'new', label: 'New', words: 'Sneaky' }];
  const byAgent = stampOrigins(written, written, baseline, 'key:abc', now, rules);
  assert.equal(byAgent[0].proposed, undefined);
  assert.equal(byAgent[1].proposed, true);
  assert.deepEqual(instructionsInTreeOrder(byAgent).map(row => row.id), ['mine']);
  // an AI cannot keep its own row
  const selfKept = stampOrigins(byAgent.map(({ proposed, ...row }) => row), [{ ...written[0] }, { ...written[1], proposed: false }], byAgent, 'key:abc', now, rules);
  assert.equal(selfKept[1].proposed, true);
  // the person keeps it by writing it with proposed false
  const kept = stampOrigins(byAgent, [{ ...written[0] }, { ...written[1], proposed: false }], byAgent, null, now, rules);
  assert.equal(kept[1].proposed, undefined);
  assert.equal(kept[1].origin, undefined);
  assert.deepEqual(instructionsInTreeOrder(kept).map(row => row.id), ['mine', 'new']);
  // a list written over an unknown baseline holds nothing
  assert.equal(stampOrigins(written, written, null, 'key:abc', now, rules)[1].proposed, undefined);
  console.log('readback picks', JSON.stringify(instructionsInTreeOrder(byAgent).map(row => row.id)), '->', JSON.stringify(instructionsInTreeOrder(kept).map(row => row.id)));
});
