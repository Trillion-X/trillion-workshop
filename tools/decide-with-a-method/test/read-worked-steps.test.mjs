// tool:read-a-decisions-worked-steps reads a decision made before method rows as its answers were written, with the method it
// was made with, and refuses a decision that does not exist. Every name and answer here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readWorkedSteps } from '../read-data/read-worked-steps.mjs';
import { startADecision } from '../read-data/decisions.mjs';
import { recordMethodAnswers } from '../method-rows/answers.mjs';
import { METHOD_VIEW, STEP_ROW, methodAccount, memoryDoor, run } from './fixtures.mjs';

const DECISION = 'source:bGVnYWN5OnNhbXBsZS0x';

// A decision made before method rows: its answers whole in `guidance` (the second answer to `scope` is the latest), and the
// method it was made with inline. `proof` is answered but is no longer a step of that method, so it is left out.
const legacy = {
  source_id: 'sample:legacy-1',
  guidance: [
    { step_id: 'scope', answer: { answer: 'An earlier scope' }, answered_at: '2026-01-02T00:00:00.000Z' },
    { step_id: 'scope', answer: { answer: 'The scope is one room' }, answered_at: '2026-01-03T00:00:00.000Z' },
    { step_id: 'proof', answer: { answer: 'A step the method no longer has' }, answered_at: '2026-01-03T00:00:00.000Z' },
    { step_id: 'outcome', answer: { note: 'Measured by a made-up note' }, answered_at: '2026-01-04T00:00:00.000Z' },
  ],
  method: {
    id: 'sample-method',
    name: 'A made-up method',
    steps: [{ id: 'scope', question: 'What is the scope?' }, { id: 'outcome', question: 'What is the outcome?' }],
  },
};

test('a legacy decision reads its answered steps as they were written, the latest answer to each, in the method it was made with', () => {
  const records = [{ id: DECISION, type: 'decision', value: legacy }];
  const before = JSON.stringify(records);
  const read = readWorkedSteps({ decision_id: DECISION, records });
  assert.equal(read.case_id, DECISION);
  assert.deepEqual(read.steps, [
    {
      step_id: 'scope',
      question: 'What is the scope?',
      rows: [{ label: 'Answer', text: 'The scope is one room' }],
      checks: [{ label: 'Checked by', text: 'The default check: the answer says something and cites a row or evidence.' }],
    },
    {
      step_id: 'outcome',
      question: 'What is the outcome?',
      rows: [{ label: 'Answer', text: 'Measured by a made-up note' }],
      checks: [{ label: 'Checked by', text: 'The default check: the answer says something and cites a row or evidence.' }],
    },
  ]);
  assert.equal(JSON.stringify(records), before, 'reading writes nothing');
});

test('a decision made with method rows reads the answers to its rows, in the method it was opened with', () => {
  const door = methodAccount(memoryDoor());
  const { case_id: id } = run(door, startADecision, {
    source_id: 'chat:worked-steps', goal: 'Decide the made-up goal', evidence: [{ ref: 'e1', claim: 'A made-up claim' }],
    options: [{ id: 'keep', label: 'Keep' }, { id: 'raise', label: 'Raise' }], method: METHOD_VIEW,
  });
  run(door, recordMethodAnswers, { decision_id: id, method: METHOD_VIEW, by: 'person', answers: [{ row: STEP_ROW('scope'), answer: 'The scope is one room', evidence_refs: ['e1'] }] });
  const read = readWorkedSteps({ decision_id: id, records: door.all() });
  assert.equal(read.case_id, id);
  assert.deepEqual(read.steps.map(step => [step.step_id, step.question, step.rows]), [
    [STEP_ROW('scope'), 'A made-up question for scope?', [{ label: 'Answer (your words)', text: 'The scope is one room' }]],
  ]);
});

test('a decision that does not exist is refused, not answered with no steps', () => {
  assert.throws(() => readWorkedSteps({ decision_id: DECISION, records: [] }), /No decision has that id/);
  assert.throws(() => readWorkedSteps({ records: [] }), /decision/i);
});
