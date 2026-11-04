// The MCP tool list shrinks to a budget only when the asking AI names one (src/tool-listing-budget.mjs), and says what it sent.
// Moved from Trillion-X/trillion test/tool-listing-budget.test.mjs, assertions unchanged. Its first and third tests run the
// list through src/tools.mjs (handleMcpMessage) and stay in trillion with that caller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listWithinBudget } from '../read-data/tool-listing-budget.mjs';

test('a budget that is not a positive number names nothing', () => {
  assert.equal(listWithinBudget([], 0), null);
  assert.equal(listWithinBudget([], 'big'), null);
});
