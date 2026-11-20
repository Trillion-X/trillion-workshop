// The words for what a decision answered at each row of its method (read-data/answer-words.mjs). Every name, row and answer
// here is made up. The answers are recorded through tool:record-method-answers, then read back through the same store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordMethodAnswers } from '../method-rows/answers.mjs';
import { answerRows, checkRows, workedSteps } from '../read-data/answer-words.mjs';
import { heldOf, memoryDoor, run } from './fixtures.mjs';

const VIEW = 'list-view:sample-methods:sample-method';
const ROW = name => `record:method-row:sample-methods~${name}`;
const DECISION = 'source:c2FtcGxlOm1ldGhvZC0x';

const ruleOf = (field, operator, params = {}) => ({ kind: 'rule', field, operator, params });
const group = (...list) => ({ kind: 'group', combinator: 'and', negate: false, rules: list });

// Three made-up method rows (a question each) in a view sorted by their offset, and one decision with two evidence refs.
function account(extra = {}) {
  const door = memoryDoor();
  door.put('list:sample-methods', 'list', { row_type: 'method-row', fields: [{ id: 'question', kind: 'long-text' }, { id: 'document.offset', kind: 'number' }] });
  door.put(VIEW, 'list-view', { list_id: 'sample-methods', view: { id: 'sample-method', label: 'A made-up method', rules: group(ruleOf('question', 'is_not_empty')), sort: [{ field: 'document.offset', direction: 'asc' }] } });
  door.put(ROW('alpha'), 'record:method-row', { question: 'Alpha question?', 'document.offset': 30, ...extra.alpha });
  door.put(ROW('beta'), 'record:method-row', { question: 'Beta question?', 'document.offset': 10 });
  door.put(ROW('gamma'), 'record:method-row', { question: 'Gamma question?', 'document.offset': 20 });
  door.put(DECISION, 'decision', { source_id: 'sample:method-1', input_identity: '1f:made-up', counts: { evidence: 3 }, refs: '1f:refs', input: { goal: 'Decide a made-up thing' } });
  door.put(`decision-refs:${DECISION}:c1f:refs`, 'decision-refs', { items: { evidence: ['1f:a', '1f:b', '1f:c'] }, step_refs: [] });
  door.put(`decision-evidence:${DECISION}:0000:c1f:a`, 'decision-evidence', { ref: 'e1', claim: 'A made-up fact' });
  door.put(`decision-evidence:${DECISION}:0001:c1f:b`, 'decision-evidence', { ref: 'gone', claim: 'A retracted fact', retracted_at: '2026-11-14T00:00:00.000Z' });
  door.put(`decision-evidence:${DECISION}:0002:c1f:c`, 'decision-evidence', { ref: 'e2', claim: 'A made-up fact laid beside the decision' });
  return door;
}

const record = (door, input) => run(door, recordMethodAnswers, { decision_id: DECISION, method: VIEW, ...input });

test('an answered row reads as its question, its labelled answer and the rows it cites, in the view order; an unanswered row is left out', () => {
  const door = account();
  const done = record(door, { by: 'person', answers: [
    { row: ROW('gamma'), answer: 'Gamma is settled', evidence_refs: ['e1'] },
    { row: ROW('beta'), answer: 'Beta is plainly done', cites: [ROW('gamma')], evidence_refs: ['e2'] },
  ] });
  assert.deepEqual(done.refused, []);
  const steps = workedSteps(heldOf(door), DECISION, VIEW);
  assert.deepEqual(steps.map(step => step.step_id), [ROW('beta'), ROW('gamma')]);
  assert.equal(steps[0].question, 'Beta question?');
  assert.deepEqual(steps[0].rows, [
    { label: 'Answer (your words)', text: 'Beta is plainly done' },
    { label: 'Cites', text: 'Gamma question?' },
  ]);
  assert.deepEqual(steps[0].checks, [{ label: 'Checked by', text: 'The default check: the answer says something and cites a row or evidence.' }]);
  assert.deepEqual(steps[1].rows, [{ label: 'Answer (your words)', text: 'Gamma is settled' }]);
  assert.equal(steps.flatMap(step => step.rows.map(row => row.text)).includes('e2'), false);
});

test('a changed answer reads as its latest version', () => {
  const door = account();
  record(door, { answers: [{ row: ROW('beta'), answer: 'First', evidence_refs: ['e1'] }] });
  record(door, { answers: [{ row: ROW('beta'), answer: 'Second', evidence_refs: ['e1'] }] });
  assert.deepEqual(workedSteps(heldOf(door), DECISION, VIEW)[0].rows, [{ label: 'Answer', text: 'Second' }]);
});

test('a row with its own review says its check and that an AI reviews the answer too', () => {
  const door = account({ alpha: { strictness: { rules: group(ruleOf('answer', 'is_not_empty')), review: true, says: 'Say it plainly.' } } });
  assert.deepEqual(record(door, { answers: [{ row: ROW('alpha'), answer: 'Alpha is done' }] }).refused, []);
  const [step] = workedSteps(heldOf(door), DECISION, VIEW);
  assert.deepEqual(step.checks, [
    { label: 'Checked by', text: 'Say it plainly.' },
    { label: 'Review', text: 'An AI reviews this answer too.' },
  ]);
});

test('no answer, a method not found, or another decision\'s answers give no worked steps; a missing method is named', () => {
  assert.deepEqual(workedSteps(heldOf(account()), DECISION, VIEW), []);
  assert.deepEqual(workedSteps(heldOf(account()), 'source:other', VIEW), []);
  assert.throws(() => workedSteps(heldOf(account()), DECISION, 'list-view:nothing'), /There is no saved method list-view:nothing/);
});

test('answerRows: the answer labelled with a word for its answerer only, a cited row without a question left out, a blank answer left out', () => {
  assert.deepEqual(answerRows({ answer: 'x', by: 'person', cites: ['missing'] }, new Map()), [{ label: 'Answer (your words)', text: 'x' }]);
  assert.deepEqual(answerRows({ answer: 'x', by: 'constructor' }, new Map()), [{ label: 'Answer', text: 'x' }]);
  assert.deepEqual(answerRows({ answer: '  ' }, new Map()), []);
  assert.deepEqual(answerRows(null, new Map()), []);
});

test('checkRows: the check of its source, the strictness\'s own sentence first, a review said only when asked, an unknown source said by nothing', () => {
  assert.deepEqual(checkRows({}, { from: 'row' }), [{ label: 'Checked by', text: 'The check this row sets for its own answers.' }]);
  assert.deepEqual(checkRows({ review: 'asked' }, { from: 'method', says: 'Mine.' }), [
    { label: 'Checked by', text: 'Mine.' },
    { label: 'Review', text: 'An AI reviews this answer too.' },
  ]);
  assert.deepEqual(checkRows({}, { from: 'constructor' }), []);
});
