// Tests the job-run screen's three buttons as pure functions (read-data/job-run-actions.mjs): each names its task move
// in tools/plan-tasks-and-todo-lists/task-moves.json, and refuses what the move would refuse. The screen does not call
// them yet, so these tests only prove the mapping and its refusals.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { jobActionMoveOf } from '../read-data/job-run-actions.mjs';

const run = { jobs: [
  { handoff_id: 'task:open', state: 'open' },
  { handoff_id: 'task:taken', state: 'taken' },
], steps: [], actors: [], progress: null };

test('take names the take move with the task id and nothing else', () => {
  assert.deepEqual(jobActionMoveOf(run, 'task:open', 'take'), { move: 'take', input: { task_id: 'task:open' } });
});

test('finish needs a non-empty result within 60000 characters and a check; the summary is optional', () => {
  assert.deepEqual(jobActionMoveOf(run, 'task:taken', 'finish', { result: 'Done.', check: { ok: true } }),
    { move: 'finish', input: { task_id: 'task:taken', result: 'Done.', check: { ok: true }, summary: null } });
  assert.equal(jobActionMoveOf(run, 'task:taken', 'finish', { result: '   ', check: 'x' }), null);
  assert.equal(jobActionMoveOf(run, 'task:taken', 'finish', { result: 'x'.repeat(60001), check: 'x' }), null);
  assert.equal(jobActionMoveOf(run, 'task:taken', 'finish', { result: 'Done.' }), null);
});

test('withdraw is only for an open job and needs the reason', () => {
  assert.deepEqual(jobActionMoveOf(run, 'task:open', 'withdraw-waiting', { because: 'Not needed now' }),
    { move: 'withdraw', input: { task_id: 'task:open', because: 'Not needed now' } });
  assert.equal(jobActionMoveOf(run, 'task:open', 'withdraw-waiting', {}), null);
  assert.equal(jobActionMoveOf(run, 'task:taken', 'withdraw-waiting', { because: 'x' }), null);
});

test('an unknown action, a follow-up, or a job the run does not hold returns null', () => {
  assert.equal(jobActionMoveOf(run, 'task:open', 'follow-up', { because: 'x' }), null);
  assert.equal(jobActionMoveOf(run, 'task:open', 'delete'), null);
  assert.equal(jobActionMoveOf(run, 'task:missing', 'take'), null);
  assert.equal(jobActionMoveOf(null, 'task:open', 'take'), null);
});

test('each mapped move exists in the task moves with the same action name', () => {
  const moves = JSON.parse(readFileSync(new URL('../../plan-tasks-and-todo-lists/task-moves.json', import.meta.url), 'utf8'));
  const actions = new Set(moves.transitions.map(row => row.action));
  for (const move of ['take', 'finish', 'withdraw']) assert.ok(actions.has(move), `${move} is a task move`);
});
