// tools/shared-code/test/agents-add-instructions.test.mjs
// The add-only import into saved instructions (F-0267, F-0316): add_instructions keeps every saved row, skips and names a row
// whose id or words are already saved, and records where each imported row came from. The rows it adds are listed by
// tools/read-other-ais-setups (its listing test is in that tool's test folder). Moved from Trillion-X/trillion
// test/ai-setups-import.test.mjs, its second test, now that src/agents.mjs lives here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeAgents } from '../src/agents.mjs';
import { agentStoreForTests } from './agent-store-for-tests.mjs';

test('add_instructions only adds: saved rows stay, duplicates are skipped and named, and each row records where it came from', () => {
  const agents = makeAgents({ store: agentStoreForTests(), now: () => new Date('2026-10-19T10:00:00Z'), starters: [] });
  agents.instructions({ instructions: [{ id: 'mine', label: 'Mine', words: 'Summarise it' }] });
  const result = agents.instructions({ add_instructions: [
    { id: 'mine', label: 'Other', words: 'Different words, same id' },
    { label: 'Same words', words: 'Summarise it' },
    { id: 'claude-commands-review', label: 'review', words: 'Review the diff for bugs.' },
  ], imported_from: 'ai-setups' }, { reader: 'key:abc' });
  assert.deepEqual(result.added, ['claude-commands-review']);
  assert.deepEqual(result.skipped.map(row => row.why), ['an instruction with this id is already saved', 'an instruction with these words is already saved']);
  const rows = Object.fromEntries(result.instructions.map(row => [row.id, row]));
  assert.equal(rows.mine.words, 'Summarise it');
  assert.equal(rows.mine.origin, undefined);
  assert.deepEqual(rows['claude-commands-review'].origin, { class: 'agent', by: 'key:abc', at: '2026-10-19T10:00:00.000Z', imported_from: 'ai-setups' });
  assert.throws(() => agents.instructions({ add_instructions: [] }), /never replaces or removes/);
  // by the person themself the import still says where it came from
  const person = agents.instructions({ add_instructions: [{ label: 'Rules', words: 'Be kind' }], imported_from: 'ai-setups' });
  assert.deepEqual(person.instructions.at(-1).origin.imported_from, 'ai-setups');
  assert.equal(person.instructions.at(-1).origin.class, 'person');
  console.log('readback import:', JSON.stringify(result.instructions.map(row => [row.id, row.origin?.class ?? 'person'])));
});
