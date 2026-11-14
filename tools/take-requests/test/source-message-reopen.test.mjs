import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { planSourceMessageReopen } from '../do-work/plan-source-message-reopen.mjs';

const taskRef = 'request:source:codex:msg_1';
const findingRef = 'finding:1';
const bindingRef = taskRef + ':outcome-binding';
const read = (payload) => ({ found: true, payload,
  content_hash: '1f:' + 'ab'.repeat(32) });
const input = {
  findingRef,
  findingRead: read({ kind: 'request-intake.outcome-verification', finding_ref: findingRef,
    binding_ref: bindingRef, result: 'failed',
    source_event_ref: 'event:1',
    source_record_ref: 'quality-owner:record:1' }),
  bindingRead: read({ kind: 'request-intake.outcome-binding', binding_ref: bindingRef,
    request_ref: taskRef, task_ref: taskRef, generation: 0,
    outcome_ref: 'live-result:1', authorized_producer_ref: 'quality-owner' }),
  observedSourceRead: read({ event_ref: 'event:1', producer_ref: 'quality-owner',
    binding_ref: bindingRef, outcome_ref: 'live-result:1', result: 'failed' }),
  requestRead: read({ kind: 'request-intake.source-message-decision',
    record_ref: taskRef, task_ref: taskRef, source_ref: 'source:codex',
    effect_class: 'owner-routed', text: 'Finish the actual work' }),
  taskStatusRead: read({ subject_id: taskRef, property_id: 'prop:task:status',
    type_id: 'type:string', value_json: 'completed' }),
  generationRead: { found: false },
  previousFindingRead: { found: false },
  at: '2026-09-24T00:00:00Z',
};

test('failed owner finding reopens the same task with one guarded generation', () => {
  const plan = planSourceMessageReopen(input);
  assert.equal(plan.status, 'reopen');
  assert.equal(plan.writes.length, 5);
  assert.equal(plan.writes[0].payload.subject_id, taskRef);
  assert.equal(plan.writes[0].payload.value_json, 'pending');
  assert.ok(plan.writes[0].expected_current.payload_hash_base64);
  assert.equal(plan.writes[1].payload.generation, 1);
  assert.equal(plan.writes[2].expected_current.payload_hash_base64, null);
  assert.equal(plan.start.sourceRecordRef,
    taskRef + ':execution-attempt:1:assigned-work-source');
});

test('unverified, repeated, active, and stale findings cannot restart work', () => {
  assert.equal(planSourceMessageReopen({
    ...input, observedSourceRead: { found: false },
  }).status, 'unverified-finding');
  assert.equal(planSourceMessageReopen({
    ...input, observedSourceRead: read({ ...input.observedSourceRead.payload,
      binding_ref: 'request:unrelated:outcome-binding' }),
  }).status, 'unverified-finding');
  assert.equal(planSourceMessageReopen({
    ...input, findingRead: read({ ...input.findingRead.payload,
      task_ref: 'request:unrelated' }),
  }).writes[0].payload.subject_id, taskRef);
  assert.equal(planSourceMessageReopen({
    ...input, bindingRead: read({ ...input.bindingRead.payload,
      task_ref: 'request:unrelated' }),
  }).status, 'request-mismatch');
  assert.equal(planSourceMessageReopen({
    ...input, previousFindingRead: read({ kind: 'request-intake.reopened-finding' }),
  }).status, 'already-reopened');
  assert.equal(planSourceMessageReopen({
    ...input, taskStatusRead: read({ ...input.taskStatusRead.payload,
      value_json: 'in_progress' }),
  }).status, 'task-not-completed');
  assert.equal(planSourceMessageReopen({
    ...input, generationRead: read({ task_ref: taskRef, generation: 1 }),
  }).status, 'stale-generation');
});

test('inactive workflow reads the owner binding before choosing the Request and Task', () => {
  const manifest = JSON.parse(readFileSync(new URL('../things-to-store-and-run.json', import.meta.url)));
  const action = manifest.things.find(row => row.payload?.id === 'action:reopen-source-message-work')?.payload;
  assert.ok(action);
  assert.equal(action.is_active, false);
  const step = id => action.steps.find(row => row.id === id);
  assert.equal(step('read_binding').config.input.address_label.select.key, 'read_finding');
  assert.equal(step('read_request').config.input.address_label.select.key, 'read_binding');
  assert.equal(step('read_task_status').config.input.address_label.select.key, 'read_binding');
  assert.equal(step('read_generation').config.input.address_label.select.key, 'read_binding');
  const process = step('plan_process').config.input;
  assert.deepEqual(process.argv.slice(4), [
    'finding.json', 'binding.json', 'source.json', 'request.json', 'status.json',
    'generation.json', 'marker.json', 'plan.json',
  ]);
  assert.equal(process.inputs.find(row => row.mount_path === 'binding.json').source.bytes.select.key,
    'read_binding');
  assert.ok(action.edges.some(edge => edge.from === 'read_finding' && edge.to === 'read_binding'));
});
