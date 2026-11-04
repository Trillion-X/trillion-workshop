// The owner declares an attribute (a tags field an audience may name), gives accounts its ids, and selects accounts by it
// (src/show-rules-store.mjs declareAttribute, give, accounts). Declared fields live on the show-rules record as
// attribute_fields; each account's ids live on its setup-context entry as attributes. Decided by the real formula engine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import { makeShowRules } from '../show-rules-store.mjs';

const wasm = () => readFileSync(new URL(import.meta.resolve('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm')));
const filter = makeRowFilter({ operators, wasm });
await filter.load();
const now = filter.filterRowsByRulesNow;
const NOW = Date.parse('2026-10-13T16:00:00Z');
const state = {};
const records = {
  read: label => state[label] ?? null,
  write: writes => writes.forEach(({ address_label, payload }) => { state[address_label] = payload; }),
  update: (label, change) => { state[label] = change(state[label] ?? null); },
};
const actor = { account_id: 'operator-account' };
const store = authority => {
  const owner = makeShowRules({ records, filterRows: now, authority, now: () => new Date(NOW), validateActor: candidate => candidate?.account_id === actor.account_id });
  return { ...owner, set: input => owner.set(input, { actor }) };
};
const parentTree = { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'family', operator: 'has_any_of', params: { values: ['parent'] } }] };

test('the owner declares an attribute once, kept on the show-rules record as a tags field', async () => {
  const { attribute, said } = await store('operator').set({ attribute: { id: 'family', label: 'Family role' } });
  assert.deepEqual(attribute, { id: 'family', label: 'Family role', kind: 'tags' });
  assert.equal(said, 'Declared the attribute Family role.');
  assert.deepEqual(state['show-rules'].attribute_fields, [{ id: 'family', label: 'Family role', kind: 'tags' }]);
});

test('a rule saved after the declaration keeps the declared attributes', async () => {
  await store('operator').set({ rule: { id: 'quiet-tour', label: 'Quiet tour', subject: 'tour', effect: 'hide', when: null } });
  assert.deepEqual(state['show-rules'].attribute_fields, [{ id: 'family', label: 'Family role', kind: 'tags' }]);
});

test('a person who is not the owner cannot declare an attribute', async () => {
  await assert.rejects(store('personal').set({ attribute: { id: 'family', label: 'Family role' } }), /Only the owner of this Trillion service declares account attributes/);
});

test('a declared id must be a lowercase word, and a fixed account fact cannot be redeclared', async () => {
  await assert.rejects(store('operator').set({ attribute: { id: 'Family Role', label: 'x' } }), /lowercase word/);
  await assert.rejects(store('operator').set({ attribute: { id: 'plan', label: 'Plan' } }), /fixed account fact/);
});

test('give assigns declared ids per account, and refuses an undeclared attribute by name', async () => {
  state['setup-context'] = { accounts: { 'account-a': { created_at: '2026-09-01T10:00:00Z' }, 'account-b': { created_at: '2026-10-02T10:00:00Z' } } };
  await store('operator').set({ give: { account_id: 'account-a', attributes: { family: { add: ['parent'] } } } });
  assert.deepEqual(state['setup-context'].accounts['account-a'].attributes, { family: ['parent'] });
  await store('operator').set({ give: { account_id: 'account-a', attributes: { family: { add: ['grandparent'], remove: ['parent'] } } } });
  assert.deepEqual(state['setup-context'].accounts['account-a'].attributes, { family: ['grandparent'] });
  await assert.rejects(store('operator').set({ give: { account_id: 'account-b', attributes: { pilot: { add: ['yes'] } } } }), /No attribute pilot is declared/);
});

test('the accounts listing selects by a declared attribute, and only the accounts it gives', async () => {
  await store('operator').set({ give: { account_id: 'account-b', attributes: { family: { add: ['parent'] } } } });
  const { accounts, said } = await store('operator').accounts({ filter: parentTree });
  assert.deepEqual(accounts.map(row => row.account_id), ['account-b']);
  assert.equal(said, '1 of 2 accounts match.');
});
