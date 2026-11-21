// The one-question-at-a-time path: step order, the next step, the drop-off step and each answer's refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepsOf, nextStepOf, lastStepReachedOf, checkAnswer, EMAIL_STEP, SLOT_STEP, CONFIRM_STEP } from '../read-data/booking-steps.mjs';

const PAGE = {
  questions: [
    { position: 1, prompt: 'Second question?' },
    { position: 0, prompt: 'First question?' },
    { position: 2, prompt: 'Optional question?', required: false },
  ],
};

test('steps are email, then the questions in position order, then slot and confirm', () => {
  assert.deepEqual(stepsOf(PAGE).map(step => step.key), [EMAIL_STEP, 'question:0', 'question:1', 'question:2', SLOT_STEP, CONFIRM_STEP]);
});

test('a page with no questions still asks email, slot and confirm', () => {
  assert.deepEqual(stepsOf({ questions: [] }).map(step => step.key), [EMAIL_STEP, SLOT_STEP, CONFIRM_STEP]);
});

test('a page whose questions are not an array, or repeat a position, is refused', () => {
  assert.throws(() => stepsOf({}), /array/);
  assert.throws(() => stepsOf({ questions: [{ position: 0, prompt: 'a' }, { position: 0, prompt: 'b' }] }), /more than once/);
  assert.throws(() => stepsOf({ questions: [{ position: 0, prompt: '  ' }] }), /prompt/);
  assert.throws(() => stepsOf({ questions: [{ position: -1, prompt: 'a' }] }), /position/);
  assert.throws(() => stepsOf({ questions: [{ position: 0, prompt: 'a', required: 'yes' }] }), /true or false/);
});

test('an empty progress waits at email, and each answer moves the next step on', () => {
  assert.equal(nextStepOf(PAGE, { email: null, answers: {}, slot: null }).key, EMAIL_STEP);
  assert.equal(nextStepOf(PAGE, { email: 'a@example.com', answers: {}, slot: null }).key, 'question:0');
  assert.equal(nextStepOf(PAGE, { email: 'a@example.com', answers: { 0: 'x' }, slot: null }).key, 'question:1');
  assert.equal(nextStepOf(PAGE, { email: 'a@example.com', answers: { 0: 'x', 1: 'y' }, slot: null }).key, 'question:2');
  assert.equal(nextStepOf(PAGE, { email: 'a@example.com', answers: { 0: 'x', 1: 'y', 2: '' }, slot: null }).key, SLOT_STEP);
  assert.equal(nextStepOf(PAGE, { email: 'a@example.com', answers: { 0: 'x', 1: 'y', 2: '' }, slot: '2026-11-24T15:00:00.000Z' }).key, CONFIRM_STEP);
});

test('a required answer that is only spaces is still waiting; an optional empty answer is done', () => {
  assert.equal(nextStepOf(PAGE, { email: 'a@example.com', answers: { 0: '   ' }, slot: null }).key, 'question:0');
});

test('the drop-off step is the last step a booking answered, in page order', () => {
  assert.equal(lastStepReachedOf(PAGE, { email: null, answers: {}, slot: null }), null);
  assert.equal(lastStepReachedOf(PAGE, { email: 'a@example.com', answers: {}, slot: null }), EMAIL_STEP);
  assert.equal(lastStepReachedOf(PAGE, { email: 'a@example.com', answers: { 0: 'x', 1: 'y' }, slot: null }), 'question:1');
  assert.equal(lastStepReachedOf(PAGE, { email: 'a@example.com', answers: { 0: 'x' }, slot: '2026-11-24T15:00:00.000Z' }), SLOT_STEP);
});

test('an email is trimmed and accepted; a bad one is refused without echoing it back', () => {
  const email = stepsOf(PAGE)[0];
  assert.deepEqual(checkAnswer(email, '  someone@example.com '), { ok: true, value: 'someone@example.com' });
  const refused = checkAnswer(email, 'not-an-email-of-mine');
  assert.equal(refused.ok, false);
  assert.equal(JSON.stringify(refused).includes('not-an-email-of-mine'), false);
  assert.equal(checkAnswer(email, '').ok, false);
  assert.equal(checkAnswer(email, `${'a'.repeat(250)}@example.com`).ok, false);
});

test('a text answer is trimmed; a required empty one and an over-long one are refused', () => {
  const [, first, , optional] = stepsOf(PAGE);
  assert.deepEqual(checkAnswer(first, ' a long answer '), { ok: true, value: 'a long answer' });
  assert.equal(checkAnswer(first, '   ').ok, false);
  assert.equal(checkAnswer(first, 'x'.repeat(2001)).ok, false);
  assert.deepEqual(checkAnswer(optional, ''), { ok: true, value: '' });
  assert.equal(checkAnswer(first, 42).ok, false);
});

test('a slot is an instant, returned in UTC; a value that is not a time is refused', () => {
  const slot = stepsOf(PAGE)[4];
  assert.deepEqual(checkAnswer(slot, '2026-11-24T10:00:00-06:00'), { ok: true, value: '2026-11-24T16:00:00.000Z' });
  assert.equal(checkAnswer(slot, 'next tuesday').ok, false);
});

test('a step that takes no answer cannot be checked as one', () => {
  assert.throws(() => checkAnswer(stepsOf(PAGE)[5], 'anything'), /takes no answer/);
});
