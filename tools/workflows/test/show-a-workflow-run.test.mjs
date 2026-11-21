// tools/workflows/test/show-a-workflow-run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHOW_PARAMS, SHOW_SQL, showRunsFor } from '../read-data/show-a-workflow-run.mjs';

test('the statement reads the tasks by their told fact\'s run input event id, one parameter', () => {
  assert.match(SHOW_SQL, /payload'->'run'->'input'->>'fact_id' = \$1/);
  assert.deepEqual(SHOW_PARAMS('where::x:1:1'), ['where::x:1:1']);
});

test('tasks are grouped by their run, so one fact that starts two runs shows both', () => {
  const rows = [
    { id: 'record:calendar-task:step-a:inventory', status: 'To do', workflow: 'workflow:port', step: 'inventory', run_key: 'aaa' },
    { id: 'record:calendar-task:step-b:inventory', status: 'To do', workflow: 'workflow:port', step: 'inventory', run_key: 'bbb' },
  ];
  const answer = showRunsFor('where::x:1:1', rows);
  assert.equal(answer.runs.length, 2);
  assert.deepEqual(answer.runs.map(run => run.run_key), ['aaa', 'bbb']);
  assert.deepEqual(answer.runs[0].tasks, [{ id: 'record:calendar-task:step-a:inventory', status: 'To do', step: 'inventory' }]);
});

test('the answer holds only ids, statuses and steps, never a task\'s details', () => {
  const answer = showRunsFor('e', [{ id: 't1', status: 'Done', workflow: 'w', step: 's', run_key: 'r', details: { secret: 'x' } }]);
  assert.deepEqual(Object.keys(answer.runs[0].tasks[0]).sort(), ['id', 'status', 'step']);
  assert.equal(JSON.stringify(answer).includes('secret'), false);
});

test('no rows answers an empty run list, and a task with no run key is left out', () => {
  assert.deepEqual(showRunsFor('e', []).runs, []);
  assert.deepEqual(showRunsFor('e', [{ id: 't', status: 'To do', run_key: null }]).runs, []);
});

test('an empty event id is refused', () => {
  assert.throws(() => showRunsFor('', []), /event id/);
});

test('the program sends one read through the door and answers the runs it finds', async () => {
  const { showWorkflowRun } = await import('../do-work/show-a-workflow-run.mjs');
  const { fakeDoor } = await import('./door-fake.mjs');
  const fake = fakeDoor({ rows: [{ id: 't1', status: 'To do', workflow: 'workflow:x', step: 'inventory', run_key: 'r1' }] });
  const answer = await showWorkflowRun({ event_id: 'where::x:1:1', database: 'person_for_test' }, { door: fake.door, fetchImpl: fake.fetchImpl });
  assert.deepEqual(answer.runs, [{ run_key: 'r1', workflow: 'workflow:x', tasks: [{ id: 't1', status: 'To do', step: 'inventory' }] }]);
  assert.equal(fake.calls[0].input.input.database, 'person_for_test');
  assert.equal(fake.calls[0].input.input.params[0], 'where::x:1:1');
});

test('a database name that is not plain is refused before any read', async () => {
  const { showWorkflowRun } = await import('../do-work/show-a-workflow-run.mjs');
  const { fakeDoor } = await import('./door-fake.mjs');
  const fake = fakeDoor();
  await assert.rejects(showWorkflowRun({ event_id: 'e', database: 'x; drop' }, { door: fake.door, fetchImpl: fake.fetchImpl }), /database/);
  assert.equal(fake.calls.length, 0);
});
