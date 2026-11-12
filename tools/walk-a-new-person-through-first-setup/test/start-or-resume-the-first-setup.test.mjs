// Tests for tool:start-or-resume-the-first-setup, written before the tool. The runs are made up; the owner tool names
// are the ones the old setup-runtime.mjs prepared, and a step whose owner tool is not in the Workshop is never called.
import assert from 'node:assert/strict';
import test from 'node:test';

import { startOrResumeTheFirstSetup } from '../do-work/start-or-resume-the-first-setup.mjs';

const fresh = { workflow: { exists: false, state: 'not_started' } };
// The owner tools the caller found in the Workshop catalogue (tools:list). A step whose owner is not in this list is not called.
// tool:run-at-a-time is not in the account Workshop, so timed_work is unavailable here.
const OWNED = ['tool:give-every-account-ready-made-workflows-and-defaults', 'tool:start-a-recipe-run'];
const account = 'acct-sample';
const ids = plan => plan.steps.map(step => step.id);

test('a fresh account gets the ordered owner steps, each with its read-back, and nothing is written here', () => {
  const plan = startOrResumeTheFirstSetup({ account_id: account, available_tools: OWNED, runtime: fresh, prerequisites: { setup_paused: false } });
  assert.equal(plan.schema, 'trillion.setup-start/v1');
  assert.equal(plan.action, 'start');
  assert.deepEqual(ids(plan), ['defaults', 'event_intake', 'workflow', 'timed_work']);
  const called = plan.steps.filter(step => step.status === 'call');
  assert.deepEqual(called.map(ids1 => ids1.id), ['defaults', 'workflow']);
  assert.ok(called.every(step => step.read_back && step.read_back.tool === 'tool:read-setup'), 'every called step names its read-back');
  assert.equal(plan.wrote, false);
});

test('a step whose owner tool is not in the Workshop is marked unavailable and is never called', () => {
  const plan = startOrResumeTheFirstSetup({ account_id: account, available_tools: OWNED, runtime: fresh });
  const eventIntake = plan.steps.find(step => step.id === 'event_intake');
  const timed = plan.steps.find(step => step.id === 'timed_work');
  assert.equal(eventIntake.status, 'unavailable');
  assert.equal(eventIntake.call, undefined);
  assert.equal(timed.status, 'unavailable');
  assert.equal(plan.steps.find(step => step.id === 'defaults').status, 'call');
});

test('steps already read back are not asked again, and the next step is the first one still to do', () => {
  const plan = startOrResumeTheFirstSetup({ account_id: account, available_tools: OWNED, runtime: fresh, done_steps: ['defaults'] });
  assert.equal(plan.steps[0].status, 'done');
  assert.equal(plan.next, 'workflow');
});

test('a stopped setup is not restarted unless the person asks for a restart', () => {
  const stopped = startOrResumeTheFirstSetup({ account_id: account, available_tools: OWNED, runtime: fresh, prerequisites: { setup_paused: true } });
  assert.equal(stopped.action, 'stopped');
  assert.equal(stopped.steps.length, 0);
  const restarted = startOrResumeTheFirstSetup({ account_id: account, available_tools: OWNED, runtime: fresh, prerequisites: { setup_paused: true }, restart: true });
  assert.equal(restarted.action, 'start');
});

test('a run that failed or got stuck resumes, with its step asked to resume', () => {
  const plan = startOrResumeTheFirstSetup({ account_id: account, available_tools: OWNED, runtime: { workflow: { exists: true, state: 'stuck', run_id: 'run:1' } } });
  assert.equal(plan.action, 'resume');
  const workflow = plan.steps.find(step => step.id === 'workflow');
  assert.equal(workflow.call.input.resume, true);
  assert.equal(workflow.call.input.run_id, 'run:1');
});

test('a finished setup has nothing to start', () => {
  const plan = startOrResumeTheFirstSetup({ account_id: account, available_tools: OWNED, runtime: { workflow: { exists: true, state: 'finished', run_id: 'run:1' } } });
  assert.equal(plan.action, 'finished');
  assert.equal(plan.steps.length, 0);
});

test('a request that is not one of its shapes is refused', () => {
  assert.throws(() => startOrResumeTheFirstSetup(['no']), /one JSON/);
  assert.throws(() => startOrResumeTheFirstSetup({ account_id: account, available_tools: OWNED }), /runtime/);
  assert.throws(() => startOrResumeTheFirstSetup({ account_id: account, available_tools: OWNED, runtime: fresh, done_steps: ['nope'] }), /done_steps/);
});
