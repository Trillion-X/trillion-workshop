// Questions asked only when their rules hold: showWhen and hideWhen are formula-engine rule trees read over the answers so far.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerFacts, isAsked, type QuestionDescriptor } from '../read-data/question-descriptor.ts';
import { readDescriptor } from '../read-data/read-forms-data.ts';
import { buildFillScreenModel } from '../read-data/fill-screen-model.ts';
import { holds } from '../do-work/rule-engine.mjs';
import { checkAnswers, registry } from '../do-work/check-answers.mjs';

const rule = (field: string, operator: string, params: Record<string, unknown> = {}) => ({ kind: 'rule', field, operator, params });
const group = (combinator: 'and' | 'or', rules: unknown[], negate = false) => ({ kind: 'group', combinator, negate, rules });

const QUESTIONS: QuestionDescriptor[] = [
  { questionId: 'who', questionTypeId: 'picks', label: 'Who is this for?', required: true, options: [{ value: 'me', label: 'Me' }, { value: 'child', label: 'My child' }] },
  { questionId: 'parent-age', questionTypeId: 'number', label: 'How old are you?', required: true, showWhen: group('and', [rule('who', 'has_any_of', { values: ['child'] })]) },
  { questionId: 'own-goal', questionTypeId: 'text', label: 'Your goal?', required: true, hideWhen: group('and', [rule('who', 'has_any_of', { values: ['child'] })]) },
  { questionId: 'anything-else', questionTypeId: 'text', label: 'Anything else?', required: false },
];

test('answers become facts by question id: a picks answer gives its picked list, others themselves, unanswered nothing', () => {
  assert.deepEqual(answerFacts({ who: { picked: ['child'] }, age: 40, note: 'x', none: null }), { who: ['child'], age: 40, note: 'x' });
});

test('a question with no rules is always asked; showWhen must hold and hideWhen must not', () => {
  assert.equal(isAsked(QUESTIONS[3], {}), true);
  assert.equal(isAsked(QUESTIONS[1], { who: { picked: ['child'] } }, holds), true);
  assert.equal(isAsked(QUESTIONS[1], { who: { picked: ['me'] } }, holds), false);
  assert.equal(isAsked(QUESTIONS[1], {}, holds), false, 'an unanswered question is unknown, so a rule about it does not hold');
  assert.equal(isAsked(QUESTIONS[2], { who: { picked: ['child'] } }, holds), false);
  assert.equal(isAsked(QUESTIONS[2], { who: { picked: ['me'] } }, holds), true);
  assert.equal(isAsked(QUESTIONS[2], {}, holds), true, 'a hide rule that cannot be read yet does not hide');
});

test('a question with rules and no engine to read them is refused, never guessed', () => {
  assert.throws(() => isAsked(QUESTIONS[1], {}), /no rule engine/);
});

test('a negated group and nested groups read as the engine reads them', () => {
  const q = { ...QUESTIONS[3], showWhen: group('or', [group('and', [rule('who', 'has_any_of', { values: ['me'] })], true), rule('age', 'at_least', { value: 18 })]) };
  assert.equal(isAsked(q, { who: { picked: ['child'] } }, holds), true);
  assert.equal(isAsked(q, { who: { picked: ['me'] }, age: 12 }, holds), false);
  assert.equal(isAsked(q, { who: { picked: ['me'] }, age: 30 }, holds), true);
});

test('the descriptor reader keeps rule trees (either spelling) and drops anything that is not one', () => {
  const kept = readDescriptor({ questionId: 'q', questionTypeId: 'text', label: 'Q', show_when: rule('who', 'is_not_empty'), hideWhen: { all: [] } });
  assert.deepEqual(kept?.showWhen, rule('who', 'is_not_empty'));
  assert.equal(kept?.hideWhen, undefined);
});

test('the whole-form check leaves out the questions not asked, so a hidden required question does not block', () => {
  const forChild = buildFillScreenModel(QUESTIONS, registry, { who: { picked: ['child'] }, 'parent-age': 41 }, { revealErrors: true, holds });
  assert.deepEqual(forChild.rows.map(row => row.descriptor.questionId), ['who', 'parent-age', 'anything-else']);
  assert.equal(forChild.allValid, true);
  const forMe = buildFillScreenModel(QUESTIONS, registry, { who: { picked: ['me'] }, 'parent-age': 41 }, { revealErrors: true, holds });
  assert.deepEqual(forMe.rows.map(row => row.descriptor.questionId), ['who', 'own-goal', 'anything-else']);
  assert.equal(forMe.allValid, false);
  assert.equal(forMe.firstInvalidId, 'own-goal');
});

test('the check-answers tool reads the rules too', () => {
  const verdict = checkAnswers({ questions: QUESTIONS, answers: { who: { picked: ['child'] }, 'parent-age': 41 } });
  assert.equal(verdict.all_valid, true);
  assert.deepEqual(verdict.questions.map((row: { questionId: string }) => row.questionId), ['who', 'parent-age', 'anything-else']);
});
