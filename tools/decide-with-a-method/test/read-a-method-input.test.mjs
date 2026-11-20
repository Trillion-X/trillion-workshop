// tools/decide-with-a-method/test/read-a-method-input.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAMethodInput } from '../method-rows/read-a-method-input.mjs';

const methodRow = { id: 'record:method:tennis', name: 'Tennis', steps: [{ id: 'goal', question: 'What is the goal?' }, { id: 'plan', question: 'What is the plan?' }] };
const checklistRows = [{ id: 'checklist:a', checks: [{ id: 'c1', step: 'goal', check: 'Is it measurable?' }] }];
const view = 'list-view:method-rows-tennis:tennis';

test('a call with no store rows is read as readAMethod reads it, refused when its records are missing', () => {
  assert.throws(() => readAMethodInput({ method: view }));
});

test('store rows shape into the saved view, steps in method order, checks on their step', () => {
  const page = readAMethodInput({ method: view, method_row: methodRow, checklist_rows: checklistRows, limit: 10 });
  assert.equal(page.method, view);
  assert.deepEqual(page.rows.map(row => row.values.question), ['What is the goal?', 'What is the plan?']);
  assert.equal(page.rows[0].values.checks[0].id, 'c1');
  assert.deepEqual(page.rows[1].values.checks, []);
});

test('a method name that is not the store row view is refused', () => {
  assert.throws(() => readAMethodInput({ method: 'list-view:other:other', method_row: methodRow, checklist_rows: checklistRows }), /is not the view/);
});

test('method_row without checklist_rows is refused', () => {
  assert.throws(() => readAMethodInput({ method: view, method_row: methodRow }), /given together/);
});
