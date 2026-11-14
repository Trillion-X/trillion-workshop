import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../things-to-store-and-run.json', import.meta.url)));
const action = manifest.things.find((row) => row.payload?.id === 'action:decide-source-message-intake')?.payload;
assert.ok(action, 'one source-message intake action is declared');
const step = (id) => action.steps.find((row) => row.id === id);
assert.equal(step('run_producer').config.definition_id, 'action:produce-ai-records');
assert.equal(step('read_owner').config.input.address_label,
  'package::ai-agent-profile::agent::founder-operator');
assert.equal(step('read_owner').config.input.address_mode, 'label_hash');
assert.equal(step('read_task').config.input.address_mode, 'label_hash');
assert.equal(step('read_claim').config.input.address_mode, 'identity_text');
assert.equal(step('read_session').config.input.address_mode, 'identity_text');

const process = step('plan_process').config.input;
assert.equal(process.argv.at(-1), 'plan.json');
const mounts = new Map(process.inputs.map((row) => [row.mount_path, row]));
for (const [name, source] of [
  ['candidate.json', 'input'], ['model-result.json', 'run_producer'],
  ['owner.json', 'read_owner'], ['existing-request.json', 'read_request'],
  ['existing-task.json', 'read_task'],
  ['existing-claim.json', 'read_claim'],
  ['existing-session.json', 'read_session'],
]) {
  assert.ok(mounts.has(name), `${name} is mounted`);
  assert.equal(mounts.get(name).source.bytes.select.from, source === 'input' ? 'input' : 'steps');
  if (source !== 'input') assert.equal(mounts.get(name).source.bytes.select.key, source);
}
assert.equal(step('cas').config.input.operation_label, 'engine.operation.write-batch');
assert.equal(step('cas').config.input.writes.select.key, 'plan_process');
assert.equal(step('dispatch_task').config.definition_id, 'action:create-task');
assert.equal(step('dispatch_task').config.inputs.select.key, 'plan_process');
for (const source of ['has_task_plan', 'task_absent', 'request_admitted']) {
  assert.ok(action.edges.some((edge) => edge.from === source && edge.to === 'dispatch_task'
    && edge.kind === 'on_result' && edge.config?.select?.path === 'output'));
}
assert.equal(step('request_admitted').join, 'any');
assert.equal(step('dispatch_task').join, 'all');
assert.ok(action.edges.some((edge) => edge.from === 'cas' && edge.to === 'new_request'));
assert.equal(step('claim_cas').config.input.operation_label, 'engine.operation.write-batch');
assert.equal(step('claim_cas').join, 'all');
for (const source of ['task_ready', 'request_admitted', 'has_claim_plan', 'claim_absent']) {
  assert.ok(action.edges.some((edge) => edge.from === source && edge.to === 'claim_cas'),
    `execution claim waits for ${source}`);
}
assert.equal(step('start_session').config.definition_id,
  'action:process-session:start-authorized-assigned-work-session');
assert.equal(step('start_session').join, 'all');
assert.ok(action.edges.some((edge) => edge.from === 'claim_cas' && edge.to === 'claim_ready'));
assert.ok(action.edges.some((edge) => edge.from === 'retryable_claim' && edge.to === 'claim_ready'));
assert.ok(action.edges.some((edge) => edge.from === 'claim_ready' && edge.to === 'start_session'));
assert.ok(action.edges.some((edge) => edge.from === 'has_start_plan' && edge.to === 'start_session'));
assert.ok(action.edges.some((edge) => edge.from === 'start_session' && edge.to === 'persist_start_binding'));

console.log('source message workflow requires Request, Task, one claim, and guarded private-local start');
