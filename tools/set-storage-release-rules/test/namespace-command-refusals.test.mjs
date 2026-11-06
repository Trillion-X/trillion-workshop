// Ported from old trillion test/namespace-command-refusals.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The release rules (src/namespace-release-rules.mjs) are this tool's; the set-aside
// store and the decision store's keep-for setting are their Workshop homes; the formula engine is tools/formula-engine.
// The byte-release store that noted gone items is retired (the plan never read it), so onGone is left at its default.
// Left out, no running owner: the hosted Namespace command routes (POST /mcp/api/namespace/release answering a rule
// without `when` with 400, and GET /mcp/api/namespace/voice/search completing inside its command). The engine's file
// door (trillion-rust src/account_files/release.rs, account-files-routes.json) runs no release rules and has no voice search.
// A Namespace command the engine refused before it ran says why (a release rule without `when`), and one item leaves by
// its id as a release rule like any other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import { checkReleaseRules, releasePlan } from '../src/namespace-release-rules.mjs';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceStore } from '../../recently-deleted-and-storage/namespace-store.mjs';
import { setAsideStore } from '../../recently-deleted-and-storage/namespace-set-aside.mjs';
import { decisionStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs';

const wasm = () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url));
const { filterRowsByRules } = makeRowFilter({ operators, wasm });
const identity = digit => `1f:${String(digit).padStart(64, '0')}`;

test('one item leaves by its id and no other does', async () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const names = namespaceStore(sql);
  const records = decisionStore(sql, { transaction });
  const now = Date.UTC(2026, 9, 1, 12);
  const keepFor = { read: () => records.setting('keep_for'), write: value => records.setSetting('keep_for', value) };
  const aside = setAsideStore(sql, { keepFor, now: () => now });
  names.putNames([1, 2, 3].map(digit => ({ name: `/file-${digit}.txt`, identity: identity(digit), byte_length: 100, modified_at_ms: now })));
  aside.setAside({ items: [1, 2, 3].map(digit => ({ name: `/file-${digit}.txt` })), state: 'deleted', by: 'person' });
  const items = aside.everything();
  const target = items[1];
  const rules = checkReleaseRules([{ id: 'one', when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'id', operator: 'is_any_of', params: { values: [target.id] } }] }, after_days: 0 }]);
  const plan = await releasePlan({ items, rules, keptBytes: 300, finalStates: new Set(['deleted']), filterRows: filterRowsByRules, now });
  assert.deepEqual(plan.now, [target.id]);
});

test('a release rule without `when` is refused with its own reason, before anything runs', () => {
  assert.throws(() => checkReleaseRules([{ id: 'a1e6a977' }]), error => error.status === 400 && error.not_sent === true && error.refusal === true && /needs when/.test(error.message));
});
