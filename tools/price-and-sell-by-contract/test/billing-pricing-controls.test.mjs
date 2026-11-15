import test from 'node:test';
import assert from 'node:assert/strict';
import { readBillingPricingControls } from '../read-data/billing-pricing-controls.mjs';

test('operator billing preserves the pricing owner rule version and scope in its save action', async () => {
  const called = [];
  const scope = { resource_id: 'resource:bytes', plan_id: 'plan:one', client_id: 'client:one' };
  const host = { isOperator: () => true, runTool: async (id, input) => {
    called.push({ id, input });
    return { rules: [{ id: 'one', version: 9, markup_bps: '3125', scope, state: 'active' }], next: 'next-page' };
  } };
  const controls = await readBillingPricingControls(host, { now: () => '2026-11-08T00:00:00Z' });
  assert.deepEqual(called, [{ id: 'tool:manage-usage-pricing', input: { action: 'list', limit: 100 } }]);
  const editor = controls.rows[0];
  assert.equal(editor.fields[0].value, '31.25');
  const action = editor.actions[0].tool;
  assert.deepEqual(action.input.rule.scope, scope);
  assert.equal(action.input.expected_version, 9);
  assert.equal(action.input.rule.effective_at, '2026-11-08T00:00:00Z');
  assert.equal(action.input.rule.markup_bps, undefined);
  assert.deepEqual(action.field_paths.markup_percent, ['rule', 'markup_percent']);
  assert.equal(controls.actions[0].href, '/use/manage-usage-pricing');
});

test('only admitted operator identity reads seller rules, and malformed answers remain unknown', async () => {
  let called = 0;
  assert.equal(await readBillingPricingControls({ isOperator: () => false, operator: true, runTool: async () => { called++; } }), null);
  assert.equal(called, 0);
  for (const answer of [{}, { rules: null }, { rules: [], next: 20 }, { rules: Array(101).fill({}) }]) {
    await assert.rejects(readBillingPricingControls({ isOperator: () => true, runTool: async () => answer }), error => error.status === 503);
  }
  await assert.rejects(readBillingPricingControls({ isOperator: () => true, runTool: async () => { throw Error('door refused'); } }), /door refused/);
  const result = await readBillingPricingControls({ isOperator: () => true, runTool: async () => ({ rules: [{ id: 'retired', version: 1, state: 'retired', markup_bps: '3000' }], next: null }) });
  assert.equal(result.rows[0].fields, undefined);
});
