// test/model-spend-all-groups.test.mjs
// The shared pool's spend read (src/model-calls.mjs spend, spendFor) is read a page at a time and never cut short: the plan meter
// totals it (PersonStore modelWorkDollarsOn) and the spend screens show it, so a store with more groups than any one page or any
// fixed cap must still total every one. The pool's own account cap reads its aggregate (refusal), not this list, and sees the same
// full total.
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountModelSpend } from '../src/model-calls.mjs';
import { sqliteHost } from '../src/local-store.mjs';
import budgets from '../src/model-budgets.json' with { type: 'json' };

const GROUPS = 5200;
const accountBudget = budgets.budgets.find(row => row.scope === 'account');

test('more than 5,000 spend groups are all totalled by the list reads and by the cap', async t => {
  const host = sqliteHost(':memory:');
  t.after(() => host.db.close());
  const matches = async (tree, facts) => tree.rules.every(rule => rule.params.values.includes(facts[rule.field]));
  const pool = accountModelSpend({ sql: host.sql, matches, rows: [{ ...accountBudget, stop: true, most: GROUPS }] });
  const day = new Date().toISOString().slice(0, 10);
  const rows = Array.from({ length: GROUPS }, (_, at) => ({ purpose: `purpose-${String(at).padStart(5, '0')}`, model: 'model-a', calls: 1, refused: 0, remembered: 0, input_tokens: 10, output_tokens: 1 }));
  await pool.report('ann', day, rows);

  const everyone = pool.spend(day);
  assert.equal(everyone.length, GROUPS, 'every group is returned');
  assert.equal(everyone.reduce((sum, row) => sum + row.calls, 0), GROUPS);
  const dollars = everyone.reduce((sum, row) => sum + row.dollars, 0);
  const one = pool.spendFor('ann', day);
  assert.equal(one.length, GROUPS);
  assert.equal(one.reduce((sum, row) => sum + row.dollars, 0), dollars, 'a person\'s read totals the same dollars');
  assert.equal(new Set(everyone.map(row => row.purpose)).size, GROUPS, 'no group is read twice across pages');

  const refused = await pool.refusal({ purpose: 'another', model: 'model-a' }, day);
  assert.ok(refused, 'the cap sees all of the day\'s calls');
  assert.equal(refused.amount, GROUPS);
});
