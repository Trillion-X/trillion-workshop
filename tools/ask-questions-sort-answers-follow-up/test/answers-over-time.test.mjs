// One person's answers over every sitting of a form, and everyone's latest standing, from kept rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answersOverTime, latestStandingOf, segmentsOf, directionOf } from '../read-data/answers-over-time.mjs';

const FORM = {
  formId: 'f', title: 'Check-in',
  questions: [
    { questionId: 'hours', label: 'Hours a week', questionTypeId: 'number' },
    { questionId: 'stroke', label: 'Weakest stroke', questionTypeId: 'picks', options: [{ value: 'fh', label: 'Forehand' }, { value: 'bh', label: 'Backhand' }] },
    { questionId: 'feel', label: 'How does your {stroke} feel?', questionTypeId: 'long-text', about: { name: 'stroke', fromQuestionId: 'stroke' } },
  ],
};
const RULES = [
  { id: 'r1', type: 'segment-rule', value: { kind: 'segment-rule', formId: 'f', min: 10, segmentId: 'a', title: 'Ready', meaning: 'Go.' } },
  { id: 'r2', type: 'segment-rule', value: { kind: 'segment-rule', formId: 'f', min: 0, segmentId: 'c', title: 'Not yet' } },
  { id: 'r3', type: 'segment-rule', value: { kind: 'segment-rule', formId: 'f', min: 5, segmentId: 'b', title: 'Close' } },
];
const fact = (sub, questionId, value, at, extra = {}) => ({ id: `answer-fact:f:p:submission:${sub}:${questionId}`, type: 'answer-fact', value: { kind: 'answer-fact', formId: 'f', respondentId: 'p', submissionId: sub, questionId, value, answered_at: at, ...extra } });
const assign = (sub, segmentId, at, respondentId = 'p') => ({ id: `segment-assignment:f:${respondentId}:submission:${sub}`, type: 'segment-assignment', value: { kind: 'segment-assignment', formId: 'f', respondentId, submissionId: sub, segmentId, score: 1, decided_at: at } });

const FACTS = [
  fact('s1', 'hours', 4, '2026-01-01T10:00:00Z'),
  fact('s1', 'stroke', { picked: ['bh'] }, '2026-01-01T10:01:00Z'),
  fact('s1', 'feel', 'Late', '2026-01-01T10:02:00Z', { about: { stroke: 'Backhand' }, asked: 'How does your backhand feel?' }),
  fact('s2', 'hours', 9, '2026-02-01T10:00:00Z'),
  fact('s2', 'stroke', { picked: ['bh'] }, '2026-02-01T10:01:00Z'),
  fact('s2', 'feel', 'Better', '2026-02-01T10:02:00Z', { about: { stroke: 'Backhand' }, asked: 'How does your backhand feel?' }),
  fact('s2', 'feel', 'Better on time', '2026-02-01T10:03:00Z', { about: { stroke: 'Backhand' }, asked: 'How does your backhand feel?' }),
  // another person's fact and another form's are never read
  { id: 'x', type: 'answer-fact', value: { kind: 'answer-fact', formId: 'f', respondentId: 'q', submissionId: 's9', questionId: 'hours', value: 1, answered_at: '2026-03-01T00:00:00Z' } },
  { id: 'y', type: 'answer-fact', value: { kind: 'answer-fact', formId: 'g', respondentId: 'p', submissionId: 's8', questionId: 'hours', value: 1, answered_at: '2026-03-01T00:00:00Z' } },
];

test('segments rank by their lowest score, and a move between ranks has a direction', () => {
  assert.deepEqual(segmentsOf(RULES).map(segment => [segment.id, segment.rank]), [['c', 0], ['b', 1], ['a', 2]]);
  const [c, b] = segmentsOf(RULES);
  assert.equal(directionOf(c, b), 'up');
  assert.equal(directionOf(b, c), 'down');
  assert.equal(directionOf(b, b), 'same');
  assert.equal(directionOf(null, b), null);
});

test('each sitting is in time order with its segment, how it moved and how many answers changed', () => {
  const model = answersOverTime({ form: FORM, facts: FACTS, assignments: [assign('s2', 'a', '2026-02-01T11:00:00Z'), assign('s1', 'b', '2026-01-01T11:00:00Z')], segmentRules: RULES, respondentId: 'p' });
  assert.deepEqual(model.sittings.map(sitting => [sitting.id, sitting.segment?.id, sitting.moved, sitting.changed]), [['s1', 'b', null, 0], ['s2', 'a', 'up', 2]]);
  assert.equal(model.latest.id, 's2');
  assert.equal(model.previous.id, 's1');
  assert.equal(model.moved, 'up');
});

test('each question is a series in form order; the latest answer in a sitting wins; numbers make a numeric series', () => {
  const model = answersOverTime({ form: FORM, facts: FACTS, respondentId: 'p' });
  assert.deepEqual(model.questions.map(line => line.question_id), ['hours', 'stroke', 'feel']);
  const [hours, stroke, feel] = model.questions;
  assert.equal(hours.numeric, true);
  assert.deepEqual(hours.answers.map(answer => answer.value), [4, 9]);
  assert.equal(stroke.numeric, false);
  assert.equal(stroke.now.words, 'Backhand');
  assert.equal(feel.label, 'How does your backhand feel?');
  assert.deepEqual(feel.answers.map(answer => answer.words), ['Late', 'Better on time']);
  assert.deepEqual(model.changes.map(line => line.question_id), ['hours', 'feel']);
});

test('a question about another thing in a later sitting is its own series, never a changed answer', () => {
  const facts = [
    fact('s1', 'feel', 'Late', '2026-01-01T10:02:00Z', { about: { stroke: 'Backhand' } }),
    fact('s2', 'feel', 'Fine', '2026-02-01T10:02:00Z', { about: { stroke: 'Forehand' } }),
  ];
  const model = answersOverTime({ form: FORM, facts, respondentId: 'p' });
  assert.equal(model.questions.length, 2);
  assert.deepEqual(model.questions.map(line => line.about.stroke).sort(), ['Backhand', 'Forehand']);
  assert.deepEqual(model.questions.map(line => line.changed), [false, false]);
  assert.deepEqual(model.questions.map(line => [line.about.stroke, line.first]).sort(), [['Backhand', false], ['Forehand', true]]);
  assert.deepEqual(model.changes, []);
});

test('one sitting is a baseline: nothing changed, no direction; no sitting is an empty model', () => {
  const one = answersOverTime({ form: FORM, facts: FACTS.slice(0, 3), respondentId: 'p' });
  assert.equal(one.sittings.length, 1);
  assert.equal(one.previous, null);
  assert.equal(one.moved, null);
  assert.deepEqual(one.changes, []);
  const none = answersOverTime({ form: FORM, facts: [], respondentId: 'p' });
  assert.deepEqual([none.sittings, none.latest, none.questions], [[], null, []]);
});

test('the follow-up is the latest segment\'s sequence; a segment no rule names is drawn by its id', () => {
  const followUps = [{ id: 'u', type: 'follow-up-sequence', value: { kind: 'follow-up-sequence', segmentId: 'a', steps: [{ stepId: 'call', label: 'Book a call' }, { stepId: 'x' }, { nope: 1 }] } }];
  const model = answersOverTime({ form: FORM, facts: FACTS, assignments: [assign('s2', 'a', '2026-02-01T11:00:00Z')], segmentRules: RULES, followUps, respondentId: 'p' });
  assert.deepEqual(model.follow_up, [{ id: 'call', label: 'Book a call' }, { id: 'x', label: 'x' }]);
  const unnamed = answersOverTime({ form: FORM, facts: FACTS, assignments: [assign('s2', 'zz', '2026-02-01T11:00:00Z')], segmentRules: RULES, respondentId: 'p' });
  assert.deepEqual([unnamed.latest.segment.title, unnamed.latest.segment.rank, unnamed.moved], ['zz', null, null]);
});

test('everyone\'s latest standing: a count per segment in rank order, one row per person, newest first, with the move', () => {
  const standing = latestStandingOf({
    formId: 'f', segmentRules: RULES,
    assignments: [assign('s1', 'b', '2026-01-01T00:00:00Z'), assign('s2', 'a', '2026-02-01T00:00:00Z'), assign('t1', 'c', '2026-03-01T00:00:00Z', 'q'),
      assign('u1', 'zz', '2026-01-15T00:00:00Z', 'r'), { id: 'o', type: 'segment-assignment', value: { formId: 'other', respondentId: 'p', segmentId: 'a' } }],
  });
  assert.deepEqual(standing.counts.map(segment => [segment.id, segment.count]), [['c', 1], ['b', 0], ['a', 1]]);
  assert.equal(standing.unplaced, 1);
  assert.deepEqual(standing.people.map(person => [person.respondent_id, person.segment.id, person.moved, person.sittings]), [['q', 'c', null, 1], ['p', 'a', 'up', 2], ['r', 'zz', null, 1]]);
});
