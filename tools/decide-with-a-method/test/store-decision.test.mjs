// The old store's rows of one decision, shaped into the records tool:read-a-decisions-worked-steps reads (read-data/store-decision.mjs).
// The rows here are made up: a real decision's rows are the person's own and never go in the repository. The shape is the one
// the store holds: a root with its method view, an answer per method row, and the method rows in the method's order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionRecordsOfStore } from '../read-data/store-decision.mjs';
import { readWorkedSteps } from '../read-data/read-worked-steps.mjs';

const decision = { id: 'source:made-up-decision', method_view: 'list-view:method-rows:the-test-steps', status: 'needs_outcome', input: '{"goal":"Choose a route"}', counts: '{"answered_steps":0,"evidence":0}', refs: undefined };
const methodList = { id: 'list:method-rows', row_type: 'method-row', fields: '[{"id":"question","kind":"long-text"}]' };
const method = { id: 'record:method:the-test-steps', name: 'Test steps', steps: '[{"id":"second","question":"Second?"},{"id":"first","question":"First?"}]' };
const methodRows = [
  { id: 'record:method-row:the-test-steps~%2Ffirst', question: 'First?', checks: '[]', extra: '{"id":"first"}' },
  { id: 'record:method-row:the-test-steps~%2Fsecond', question: 'Second?', checks: '[]', extra: '{"id":"second"}' },
];
const answers = [
  { id: 'method-answer:source:made-up-decision:record%3Amethod-row%3Athe-test-steps~%252Ffirst', answer: 'Take the short road.', by: 'calling-ai', cites: '[]', decision_id: decision.id, method: decision.method_view, row: 'record:method-row:the-test-steps~%2Ffirst', strictness: 'default', version: '1' },
];

test('a stored decision with one answer reads that answer as the worked step, in the method order', () => {
  const records = decisionRecordsOfStore({ decision, answers, methodList, methodRows, method });
  const { case_id, steps } = readWorkedSteps({ decision_id: decision.id, records });
  assert.equal(case_id, decision.id);
  assert.deepEqual(steps.map(step => step.step_id), ['record:method-row:the-test-steps~%2Ffirst']);
  assert.equal(steps[0].question, 'First?');
  assert.deepEqual(steps[0].rows, [{ label: steps[0].rows[0].label, text: 'Take the short road.' }]);
});

test('the view keeps the rows in the method order (the step order), not the order the rows were handed in', () => {
  const answerBoth = answers.concat([{ ...answers[0], id: 'method-answer:source:made-up-decision:record%3Amethod-row%3Athe-test-steps~%252Fsecond', row: 'record:method-row:the-test-steps~%2Fsecond' }]);
  const records = decisionRecordsOfStore({ decision, answers: answerBoth, methodList, methodRows, method });
  const { steps } = readWorkedSteps({ decision_id: decision.id, records });
  assert.deepEqual(steps.map(step => step.step_id), ['record:method-row:the-test-steps~%2Fsecond', 'record:method-row:the-test-steps~%2Ffirst']);
});

test('a decision with no answers yet reads no steps', () => {
  const records = decisionRecordsOfStore({ decision, answers: [], methodList, methodRows, method });
  assert.deepEqual(readWorkedSteps({ decision_id: decision.id, records }).steps, []);
});
