// A saved instruction over its budget is refused with the exact excess, never cut short silently (src/agents.mjs instructionsFrom).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

test('words over the limit are refused saying how many characters to take out; a row at the limit is kept whole', () => {
  const agents = makeAgents({ store: agentStoreForTests() });
  const over = 'x'.repeat(2037);
  assert.throws(() => agents.instructions({ instructions: [{ label: 'Long one', words: over }] }), error => {
    console.log('REFUSED:', error.message);
    return /words is 37 characters over its 2000-character limit\. Shorten it by 37/.test(error.message);
  });
  const exact = 'y'.repeat(2000);
  const saved = agents.instructions({ instructions: [{ label: 'Exact', words: exact }] });
  assert.equal(saved.instructions[0].words.length, 2000);
  assert.throws(() => agents.instructions({ instructions: [{ label: 'z'.repeat(125), words: 'ok' }] }), /label is 5 characters over its 120-character limit/);
});
