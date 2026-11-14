import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../things-to-store-and-run.json', import.meta.url)));
const action = manifest.things.find((row) => row.payload?.id === 'action:read-source-message-work')?.payload;
assert.ok(action, 'the source-message work reader is declared');
assert.equal(action.input_schema.required[0], 'record_ref');
assert.deepEqual(action.steps.map((step) => step.kind), ['ask', 'ask', 'ask', 'ask', 'return']);
for (const step of action.steps.slice(0, 4)) {
  assert.equal(step.config.name, 'engine.operation.label-addressed');
  assert.equal(step.config.input.operation_label, 'engine.operation.read-current');
}
const byId = new Map(action.steps.map((step) => [step.id, step]));
assert.equal(byId.get('request').config.input.address_mode, 'identity_text');
assert.equal(byId.get('task').config.input.address_mode, 'label_hash');
assert.equal(byId.get('task').config.input.address_label.transform[0].args.prefix, 'entity|');
assert.equal(byId.get('claim').config.input.address_mode, 'identity_text');
assert.equal(byId.get('claim').config.input.address_label.transform[0].args.values.at(-1), ':execution-claim');
assert.equal(byId.get('session').config.input.address_label.transform[0].args.values.at(-1), ':execution-session');
assert.deepEqual(Object.keys(byId.get('return').config.value), ['record_ref', 'request', 'task', 'claim', 'session']);
assert.deepEqual(action.edges.map((edge) => `${edge.from}->${edge.to}`),
  ['request->task', 'task->claim', 'claim->session', 'session->return']);

console.log('source-message work reader uses four exact owner reads and writes nothing');
