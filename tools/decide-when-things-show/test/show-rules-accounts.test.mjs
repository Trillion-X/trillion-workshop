// The owner of this Trillion service lists the accounts its setup-context record holds, filtered by a rule tree over the
// account facts (src/show-rules-store.mjs accounts), so one, many or a filtered set can be given a type. Only the owner
// lists; a fact the record does not hold is null, never a guess.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import { makeShowRules } from '../read-data/show-rules-store.mjs';

const wasm = () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url));
const filter = makeRowFilter({ operators, wasm });
await filter.load();
const now = filter.filterRowsByRulesNow;
const NOW = Date.parse('2026-10-13T16:00:00Z');
const context = {
  accounts: {
    'account-a': { created_at: '2026-09-01T10:00:00Z', cohorts: ['simple-workspace'], experiments: ['tour-b'] },
    'account-b': { created_at: '2026-10-02T10:00:00Z', cohorts: [] },
    'account-c': { cohorts: ['simple-workspace'] },
  },
};
const records = { read: label => (label === 'setup-context' ? context : null), write() {}, update() {} };
const store = authority => makeShowRules({ records, filterRows: now, authority, now: () => new Date(NOW) });
const cohortTree = { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'cohorts', operator: 'has_any_of', params: { values: ['simple-workspace'] } }] };

test('the owner lists every account the setup-context record holds, with the facts that record holds', async () => {
  const { accounts } = await store('operator').accounts();
  assert.deepEqual(accounts.map(row => row.account_id).sort(), ['account-a', 'account-b', 'account-c']);
  const a = accounts.find(row => row.account_id === 'account-a').facts;
  assert.equal(a.created_at, Date.parse('2026-09-01T10:00:00Z'));
  assert.deepEqual(a.cohorts, ['simple-workspace']);
  assert.deepEqual(a.experiments, ['tour-b']);
});

test('facts the record does not hold read as null, never as a guess', async () => {
  const { accounts } = await store('operator').accounts();
  const c = accounts.find(row => row.account_id === 'account-c').facts;
  assert.equal(c.created_at, null);
  assert.equal(c.plan, null);
  assert.equal(c.setup_done, null);
  assert.equal(c.ai_connected, null);
});

test('a filter selects the accounts a rule tree holds for, and only those', async () => {
  const { accounts, said } = await store('operator').accounts({ filter: cohortTree });
  assert.deepEqual(accounts.map(row => row.account_id).sort(), ['account-a', 'account-c']);
  assert.equal(said, '2 of 3 accounts match.');
});

test('a person who is not the owner cannot list accounts', async () => {
  await assert.rejects(store('personal').accounts(), /Only the owner of this Trillion service lists accounts/);
});

test('a filter that is not a rule tree is refused in words', async () => {
  await assert.rejects(store('operator').accounts({ filter: { kind: 'rule' } }), /filter is a rule tree/);
});
