import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url).pathname;
const contract = JSON.parse(readFileSync(join(root, 'things-to-store-and-run.json'), 'utf8'));
const payloads = new Map(contract.things.map((thing) => [thing.address, thing.payload]));

const graph = payloads.get('package::notifications::published-record::record-policy-action-graph::settings-policy');
const route = graph.action_routes[0];
const sideEffectRoute = payloads.get('package::notifications::published-record::side-effect-intent-route::authority-owned-action');

const existingOwners = new Set(['slot::workflow']);

for (const candidate of [route, sideEffectRoute.route]) {
  assert.equal(existingOwners.has(candidate.target), true, `${candidate.target} is not an existing owner route`);
  assert.equal(candidate.method, 'execute_definition');
  assert.equal(candidate.bindings.definition_id, 'action:update-workspace-notification-mode');
}

assert.deepEqual(route.input_schema, {
  mode_id: {
    from: 'selected_option_id',
    required: true,
  },
});
assert.equal(sideEffectRoute.intent.single_execution_owner, 'workflow');
assert.deepEqual(sideEffectRoute.intent.idempotency_key, { from: 'intent_id' });

console.log('notifications action-route gate passed');
