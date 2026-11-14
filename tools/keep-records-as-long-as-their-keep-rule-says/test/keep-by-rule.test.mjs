// tools/keep-records-as-long-as-their-keep-rule-says/test/keep-by-rule.test.mjs
//
// Purpose: the keep tool hands the engine exactly the rule a declaration names, in the shape the engine's wake reads
// (`wake_effects`, beside the result), and nothing else: no record read, no time counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import rows from '../tool-rows.json' with { type: 'json' };
import { answerOf } from '../../../test-helpers/run-a-row.mjs';
import { keepByRule } from '../read-data/keep-by-rule.mjs';

test('a declaration naming a rule asks the engine to keep by that rule, in the account\'s own records by default', () => {
  const answer = keepByRule({ rule: 'record:keep-rule:logs' });
  assert.deepEqual(answer.wake_effects, [{ keep: { resource: 'own-records', rule: 'record:keep-rule:logs' } }]);
  assert.match(answer.said, /record:keep-rule:logs/);
});

test('a declaration may name another resource, and a call naming no rule asks for nothing', () => {
  assert.equal(keepByRule({ rule: 'r', resource: 'notes' }).wake_effects[0].keep.resource, 'notes');
  assert.throws(() => keepByRule({}), /Say which keep rule/);
  assert.throws(() => keepByRule({ rule: '  ' }), /Say which keep rule/);
});

test('the row runs the function the way the engine does and prints the effect beside the result', async () => {
  const row = structuredClone(rows.records.find(record => record.payload.id === 'tool:keep-by-its-rule').payload);
  const run = await answerOf(row, { rule: 'record:keep-rule:logs' }, { records: [] });
  assert.equal(run.status, 0);
  assert.deepEqual(run.wake_effects, [{ keep: { resource: 'own-records', rule: 'record:keep-rule:logs' } }]);
});
