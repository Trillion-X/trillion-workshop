// The form tools run as the container runs them, with no records door: each takes the rows it works from as input
// and answers its result, and nothing is kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const save = rowOf(rows, 'tool:save-a-form');
const submit = rowOf(rows, 'tool:submit-form-answers');
const results = rowOf(rows, 'tool:read-form-results');
const progress = rowOf(rows, 'tool:read-answer-progress');
const lines = rowOf(rows, 'tool:read-latest-answers-as-lines');

const form = {
  form_id: 'intake',
  title: 'Intake',
  questions: [
    { questionId: 'budget', questionTypeId: 'number', label: 'Budget', required: true },
    { questionId: 'email', questionTypeId: 'text', label: 'Email', required: true },
    { questionId: 'focus', questionTypeId: 'rating', label: 'Focus', validation: { min: 1, max: 10 } },
  ],
};
const rules = [
  { id: 'score-rule:budget', type: 'score-rule', value: { kind: 'score-rule', readKey: 'budget', match: { gte: 1000 }, points: 10 } },
  { id: 'score-rule:email', type: 'score-rule', value: { kind: 'score-rule', readKey: 'email', match: { has_value: true }, points: 12 } },
  { id: 'segment-rule:cold', type: 'segment-rule', value: { kind: 'segment-rule', min: 0, segmentId: 'cold' } },
  { id: 'segment-rule:hot', type: 'segment-rule', value: { kind: 'segment-rule', min: 20, segmentId: 'hot' } },
  { id: 'follow-up-sequence:hot', type: 'follow-up-sequence', value: { kind: 'follow-up-sequence', segmentId: 'hot', steps: [{ stepId: 'call', label: 'Call back' }] } },
];

const noDoor = ran => {
  assert.equal(ran.status, 0, ran.error);
  assert.deepEqual(ran.calls ?? [], [], 'the run is handed no records door');
  assert.deepEqual(ran.kept ?? [], [], 'nothing is kept');
};

async function made(definition = form) {
  const ran = await answerOf(save, definition);
  noDoor(ran);
  return ran.result.record;
}

test('a form comes back as the one question-sequence record the fill side reads, and is kept nowhere', async () => {
  const ran = await answerOf(save, form);
  noDoor(ran);
  assert.deepEqual([ran.result.form_id, ran.result.record_id, ran.result.question_count], ['intake', 'question-sequence:intake', 3]);
  assert.deepEqual([ran.result.record.id, ran.result.record.type, ran.result.record.value.kind, ran.result.record.value.questions.length], ['question-sequence:intake', 'question-sequence', 'question-sequence', 3]);
  const refused = await answerOf(save, { form_id: 'intake', questions: [{ label: 'no id' }] });
  assert.equal(refused.status, 1);
  assert.match(refused.error, /questions\[0\] needs a questionId and a questionTypeId/);
});

test('answers that fail the form are refused with the first to fix, and no records come back', async () => {
  const record = await made();
  const ran = await answerOf(submit, { form_id: 'intake', respondent_id: 'r1', answers: { budget: 'a lot' }, records: [record] });
  noDoor(ran);
  assert.equal(ran.result.accepted, false);
  assert.equal(ran.result.first_invalid, 'budget');
  assert.equal(ran.result.records, undefined);
});

test('a valid submission answers its facts and its decision as records, reading the rules from the records it is given', async () => {
  const record = await made();
  const answers = { budget: '2000', email: 'user-ebb18a03@example.com', focus: 8, stray: 'not in the form' };
  const ran = await answerOf(submit, { form_id: 'intake', respondent_id: 'r1', answers, answered_at: '2026-06-26T00:00:00Z', records: [record, ...rules] });
  noDoor(ran);
  assert.equal(ran.result.accepted, true);
  assert.equal(ran.result.decision.segmentId, 'hot');
  assert.equal(ran.result.decision.score, 22);
  assert.equal(ran.result.follow_up.steps[0].label, 'Call back');
  assert.deepEqual(ran.result.ignored, ['stray']);
  assert.deepEqual(ran.result.records.map(item => item.id).sort(), [
    'answer-fact:intake:r1:budget', 'answer-fact:intake:r1:email', 'answer-fact:intake:r1:focus', 'segment-assignment:intake:r1',
  ]);
  assert.equal(ran.result.records.find(item => item.id === 'answer-fact:intake:r1:budget').value.value, 2000, 'a number answer comes back as a number');
});

test('a submission to a form the records do not hold is refused', async () => {
  const ran = await answerOf(submit, { form_id: 'intake', respondent_id: 'r1', answers: {}, records: rules });
  assert.equal(ran.status, 1);
  assert.match(ran.error, /records holds no form intake/);
});

test('a question\'s after-saved hand-off becomes a request record for its owner', async () => {
  const record = await made({ ...form, form_id: 'with-handoff', questions: [{ questionId: 'goal', questionTypeId: 'text', label: 'Goal', afterSaved: { owner: 'tasks', actionRef: 'action:create-task', input: { title: '$answer.goal', for: '$run.scope_ref' } } }] });
  const ran = await answerOf(submit, { form_id: 'with-handoff', respondent_id: 'r2', submission_id: 's1', answers: { goal: 'Plan the week' }, answered_at: '2026-06-26T00:00:00Z', records: [record] });
  noDoor(ran);
  const request = ran.result.records.find(item => item.type === 'owner-action-request');
  assert.equal(request.value.owner, 'tasks');
  assert.deepEqual(request.value.input, { title: 'Plan the week', for: 'r2' });
  assert.equal(request.value.status, 'requested');
  assert.deepEqual(ran.result.action_requests.map(item => item.actionRef), ['action:create-task']);
});

async function answered(respondent, answers, at, extra = {}) {
  const record = await made();
  const ran = await answerOf(submit, { form_id: 'intake', respondent_id: respondent, answers: { email: 'user-ebb18a03@example.com', ...answers }, answered_at: at, records: [record, ...rules], ...extra });
  noDoor(ran);
  return ran.result.records;
}

test('results list each respondent\'s segment from the assignments given, newest first, with a count per segment', async () => {
  const records = [...await answered('r1', { budget: 2000 }, '2026-06-26T00:00:00Z'), ...await answered('r2', { budget: 10 }, '2026-06-27T00:00:00Z')];
  const ran = await answerOf(results, { form_id: 'intake', records });
  noDoor(ran);
  assert.deepEqual(ran.result.rows.map(row => [row.respondentId, row.segmentId]), [['r2', 'cold'], ['r1', 'hot']]);
  assert.deepEqual(ran.result.summary, { total: 2, bySegment: { cold: 1, hot: 1 } });
  assert.deepEqual((await answerOf(results, { records: [] })).result, { rows: [], summary: { total: 0, bySegment: {} } }, 'nothing is shown until someone answers');
});

test('progress folds one respondent\'s sessions into ordered rows and a trend', async () => {
  const sessions = [
    ...await answered('r1', { budget: 1, focus: 4 }, '2026-06-20T18:00:00Z', { submission_id: 's1' }),
    ...await answered('r1', { budget: 1, focus: 8 }, '2026-06-27T18:00:00Z', { submission_id: 's2' }),
  ].filter(record => record.type === 'answer-fact');
  const ran = await answerOf(progress, { form_id: 'intake', respondent_id: 'r1', field_map: { focus: 'focus' }, records: sessions });
  noDoor(ran);
  assert.deepEqual(ran.result.rows.map(row => row.fields.focus), [4, 8]);
  assert.deepEqual(ran.result.trend, { field: 'focus', points: [4, 8] });
  assert.equal(ran.result.count, 2);
});

test('the latest answers read back as lines, each labelled with its question', async () => {
  const record = await made();
  const facts = await answered('r1', { budget: 5 }, '2026-06-26T00:00:00Z');
  const ran = await answerOf(lines, { form_id: 'intake', respondent_id: 'r1', records: [record, ...facts] });
  noDoor(ran);
  assert.deepEqual([...ran.result.lines].sort(), ['Budget: 5', 'Email: user-ebb18a03@example.com']);
});

test('no row asks for a records door, and every reader asks for its rows as input', () => {
  for (const row of [save, submit, results, progress, lines]) {
    assert.equal(row.invoke.records, undefined, `${row.id} declares no records door`);
    assert.equal(row.invoke.internet, false);
  }
  for (const row of [submit, results, progress, lines]) assert.ok(row.input_schema.required.includes('records'), `${row.id} takes records`);
});
