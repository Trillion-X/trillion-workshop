// The one-question-at-a-time path: step order, the next step, the drop-off step and each answer's refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepsOf, nextStepOf, lastStepReachedOf, checkAnswer, askedStep, EMAIL_STEP, SLOT_STEP, CONFIRM_STEP } from '../read-data/booking-steps.mjs';

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
  assert.deepEqual(checkAnswer(first, ' a long answer '), { ok: true, value: 'a long answer', text: 'a long answer' });
  assert.equal(checkAnswer(first, '   ').ok, false);
  assert.equal(checkAnswer(first, 'x'.repeat(2001)).ok, false);
  assert.deepEqual(checkAnswer(optional, ''), { ok: true, value: '', text: '' });
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

const STROKES = [{ label: 'Forehand', value: 'forehand' }, { label: 'Serve', value: 'serve' }];
const PICKS_PAGE = {
  questions: [
    { position: 0, prompt: 'Which stroke?', question: { questionId: 'stroke', questionTypeId: 'picks', options: STROKES, other: { label: 'Other', value: 'other' } } },
    { position: 1, prompt: 'When does your {stroke} break down?', question: { questionId: 'breaks', questionTypeId: 'picks', multiple: true, options: [{ label: 'Fast balls', value: 'fast' }, { label: 'High balls', value: 'high' }], about: { name: 'stroke', fromQuestionId: 'stroke' } } },
    { position: 2, prompt: 'Your {stroke} video', required: false, question: { questionId: 'video', questionTypeId: 'link', about: { name: 'stroke', fromQuestionId: 'stroke' } } },
    { position: 3, prompt: 'Age', question: { questionId: 'age', questionTypeId: 'number', validation: { min: 5, max: 99 } } },
  ],
};

test('a question is the form owner\'s descriptor: its type is checked against the owner\'s question types', () => {
  const [, stroke] = stepsOf(PICKS_PAGE);
  assert.equal(stroke.kind, 'question');
  assert.equal(stroke.question.questionTypeId, 'picks');
  assert.equal(stepsOf(PAGE)[1].question.questionTypeId, 'long-text');
  assert.throws(() => stepsOf({ questions: [{ position: 0, prompt: 'a', question: { questionTypeId: 'colour' } }] }), /colour/);
  assert.throws(() => stepsOf({ questions: [{ position: 0, prompt: 'a', question: { questionId: 'x' } }, { position: 1, prompt: 'b', question: { questionId: 'x' } }] }), /more than once/);
});

test('picks take one listed answer, or several where the question allows, and the other option needs words', () => {
  const [, stroke, breaks] = stepsOf(PICKS_PAGE);
  assert.deepEqual(checkAnswer(stroke, { picked: ['serve'] }), { ok: true, value: { picked: ['serve'] }, text: 'Serve' });
  assert.equal(checkAnswer(stroke, { picked: ['serve', 'forehand'] }).ok, false);
  assert.equal(checkAnswer(stroke, { picked: ['lob'] }).ok, false);
  assert.equal(checkAnswer(stroke, { picked: ['other'] }).ok, false);
  assert.deepEqual(checkAnswer(stroke, { picked: ['other'], other: ' Lob ' }), { ok: true, value: { picked: ['other'], other: 'Lob' }, text: 'Other: Lob' });
  assert.deepEqual(checkAnswer(breaks, { picked: ['fast', 'high'] }).text, 'Fast balls; High balls');
  assert.equal(checkAnswer(breaks, { picked: [] }).ok, false);
});

test('a link must be a full web link, a number stays inside its bounds', () => {
  const [, , , video, age] = stepsOf(PICKS_PAGE);
  assert.equal(checkAnswer(video, 'https://youtu.be/abc').ok, true);
  assert.equal(checkAnswer(video, 'youtu.be/abc').ok, false);
  assert.deepEqual(checkAnswer(video, ''), { ok: true, value: '', text: '' });
  assert.deepEqual(checkAnswer(age, '14'), { ok: true, value: 14, text: '14' });
  assert.equal(checkAnswer(age, '3').ok, false);
});

test('a question about an earlier answer is asked with that answer in it, and says what it is about', () => {
  const progress = { email: 'a@example.com', answers: { 0: { picked: ['serve'] } }, slot: null };
  const next = nextStepOf(PICKS_PAGE, progress);
  assert.equal(next.key, 'question:1');
  assert.deepEqual(askedStep(PICKS_PAGE, next, progress).prompt, 'When does your serve break down?');
  assert.deepEqual(askedStep(PICKS_PAGE, next, progress).about, { stroke: 'Serve' });
  assert.equal(nextStepOf(PICKS_PAGE, { ...progress, answers: { 0: { picked: ['lob'] } } }).key, 'question:0');
});

test('a question asked only when its rules hold is passed by while they do not, and asked once they do', () => {
  const rule = (field, operator, params = {}) => ({ kind: 'rule', field, operator, params });
  const page = {
    questions: [
      { position: 0, prompt: 'Who is this for?', question: { questionId: 'who', questionTypeId: 'picks', options: [{ value: 'me', label: 'Me' }, { value: 'child', label: 'My child' }] } },
      { position: 1, prompt: 'How old are you?', question: { questionId: 'parent-age', questionTypeId: 'number', showWhen: { kind: 'group', combinator: 'and', negate: false, rules: [rule('who', 'has_any_of', { values: ['child'] })] } } },
      { position: 2, prompt: 'Your goal?', question: { questionId: 'own-goal', questionTypeId: 'text', hideWhen: rule('who', 'has_any_of', { values: ['child'] }) } },
    ],
  };
  const at = answers => nextStepOf(page, { email: 'a@example.com', answers, slot: null }).key;
  assert.equal(at({}), 'question:0');
  assert.equal(at({ 0: { picked: ['me'] } }), 'question:2', 'the parent question is passed by for the player');
  assert.equal(at({ 0: { picked: ['me'] }, 2: 'Win more' }), SLOT_STEP);
  assert.equal(at({ 0: { picked: ['child'] } }), 'question:1', 'the parent question is asked for a parent');
  assert.equal(at({ 0: { picked: ['child'] }, 1: 41 }), SLOT_STEP, 'the player goal is hidden for a parent');
});
