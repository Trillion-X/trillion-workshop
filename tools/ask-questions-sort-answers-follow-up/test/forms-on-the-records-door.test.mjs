// The form tools run as the container runs them, against the fake records door with exactly each row's rights:
// save a form, check and record a respondent's answers with their decision, and read the results back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
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

async function saved() {
  const ran = await runRow(save, form);
  assert.equal(ran.status, 0, ran.error);
  return ran;
}

test('saving a form keeps one question-sequence record the fill side reads', async () => {
  const ran = await saved();
  assert.deepEqual(ran.result, { saved: true, form_id: 'intake', record_id: 'question-sequence:intake', question_count: 3 });
  assert.deepEqual(ran.kept.map(record => [record.id, record.type, record.value.kind, record.value.questions.length]), [['question-sequence:intake', 'question-sequence', 'question-sequence', 3]]);
  const refused = await runRow(save, { form_id: 'intake', questions: [{ label: 'no id' }] });
  assert.equal(refused.status, 1);
  assert.match(refused.error, /questions\[0\] needs a questionId and a questionTypeId/);
});

test('answers that fail the form are refused with the first to fix, and nothing is written', async () => {
  const { kept } = await saved();
  const ran = await runRow(submit, { form_id: 'intake', respondent_id: 'r1', answers: { budget: 'a lot' } }, { records: kept });
  assert.equal(ran.status, 0, ran.error);
  assert.equal(ran.result.accepted, false);
  assert.equal(ran.result.first_invalid, 'budget');
  assert.equal(ran.kept.length, kept.length, 'a refused submission writes nothing');
  assert.equal(ran.calls.some(call => call.method === 'records:write'), false);
});

test('a valid submission writes its answer facts and its decision together, and reads the rules as records', async () => {
  const { kept } = await saved();
  const answers = { budget: '2000', email: 'a@b.example', focus: 8, stray: 'not in the form' };
  const ran = await runRow(submit, { form_id: 'intake', respondent_id: 'r1', answers, answered_at: '2026-06-26T00:00:00Z' }, { records: [...kept, ...rules] });
  assert.equal(ran.status, 0, ran.error);
  assert.equal(ran.result.accepted, true);
  assert.equal(ran.result.decision.segmentId, 'hot');
  assert.equal(ran.result.decision.score, 22);
  assert.equal(ran.result.follow_up.steps[0].label, 'Call back');
  assert.deepEqual(ran.result.ignored, ['stray']);
  const written = ran.kept.filter(record => record.type === 'answer-fact' || record.type === 'segment-assignment');
  assert.deepEqual(written.map(record => record.id).sort(), [
    'answer-fact:intake:r1:budget', 'answer-fact:intake:r1:email', 'answer-fact:intake:r1:focus', 'segment-assignment:intake:r1',
  ]);
  assert.equal(written.find(record => record.id === 'answer-fact:intake:r1:budget').value.value, 2000, 'a number answer is kept as a number');
  assert.equal(ran.calls.filter(call => call.method === 'records:write').length, 1, 'answers and decision go in one write');
});

test('a question\'s after-saved hand-off becomes a request record for its owner', async () => {
  const handoff = { ...form, form_id: 'with-handoff', questions: [{ questionId: 'goal', questionTypeId: 'text', label: 'Goal', afterSaved: { owner: 'tasks', actionRef: 'action:create-task', input: { title: '$answer.goal', for: '$run.scope_ref' } } }] };
  const { kept } = await runRow(save, handoff);
  const ran = await runRow(submit, { form_id: 'with-handoff', respondent_id: 'r2', submission_id: 's1', answers: { goal: 'Plan the week' }, answered_at: '2026-06-26T00:00:00Z' }, { records: kept });
  assert.equal(ran.status, 0, ran.error);
  const request = ran.kept.find(record => record.type === 'owner-action-request');
  assert.equal(request.value.owner, 'tasks');
  assert.deepEqual(request.value.input, { title: 'Plan the week', for: 'r2' });
  assert.equal(request.value.status, 'requested');
  assert.deepEqual(ran.result.action_requests.map(item => item.actionRef), ['action:create-task']);
});

test('results list each respondent\'s segment, newest first, with a count per segment', async () => {
  const { kept } = await saved();
  const answer = (respondent, budget, at) => runRow(submit, { form_id: 'intake', respondent_id: respondent, answers: { budget, email: 'a@b.example' }, answered_at: at }, { records: [...kept, ...rules] });
  const one = await answer('r1', 2000, '2026-06-26T00:00:00Z');
  const two = await answer('r2', 10, '2026-06-27T00:00:00Z');
  const ran = await runRow(results, { form_id: 'intake' }, { records: [...one.kept, ...two.kept] });
  assert.equal(ran.status, 0, ran.error);
  assert.deepEqual(ran.result.rows.map(row => [row.respondentId, row.segmentId]), [['r2', 'cold'], ['r1', 'hot']]);
  assert.deepEqual(ran.result.summary, { total: 2, bySegment: { cold: 1, hot: 1 } });
  assert.deepEqual((await runRow(results, {})).result, { rows: [], summary: { total: 0, bySegment: {} } }, 'nothing is shown until someone answers');
});

test('progress folds one respondent\'s sessions into ordered rows and a trend', async () => {
  const { kept } = await saved();
  const sessions = [];
  for (const [id, at, focus] of [['s1', '2026-06-20T18:00:00Z', 4], ['s2', '2026-06-27T18:00:00Z', 8]]) {
    const ran = await runRow(submit, { form_id: 'intake', respondent_id: 'r1', submission_id: id, answers: { budget: 1, email: 'a@b.example', focus }, answered_at: at }, { records: [...kept, ...sessions] });
    assert.equal(ran.status, 0, ran.error);
    sessions.push(...ran.kept.filter(record => record.type === 'answer-fact'));
  }
  const ran = await runRow(progress, { form_id: 'intake', respondent_id: 'r1', field_map: { focus: 'focus' } }, { records: sessions });
  assert.equal(ran.status, 0, ran.error);
  assert.deepEqual(ran.result.rows.map(row => row.fields.focus), [4, 8]);
  assert.deepEqual(ran.result.trend, { field: 'focus', points: [4, 8] });
  assert.equal(ran.result.count, 2);
});

test('the latest answers read back as lines, each labelled with its question', async () => {
  const { kept } = await saved();
  const sent = await runRow(submit, { form_id: 'intake', respondent_id: 'r1', answers: { budget: 5, email: 'a@b.example' }, answered_at: '2026-06-26T00:00:00Z' }, { records: kept });
  const ran = await runRow(lines, { form_id: 'intake', respondent_id: 'r1' }, { records: sent.kept });
  assert.equal(ran.status, 0, ran.error);
  assert.deepEqual([...ran.result.lines].sort(), ['Budget: 5', 'Email: a@b.example']);
});

test('each row asks the door only for the records kinds it needs', () => {
  const rights = row => row.invoke.records.rights.map(item => `${item.kind}:${item.operations.join('+')}`).sort();
  assert.deepEqual(rights(save), ['question-sequence:records:write']);
  assert.deepEqual(rights(results), ['segment-assignment:records:list']);
  assert.deepEqual(rights(progress), ['answer-fact:records:list']);
  assert.deepEqual(rights(lines), ['answer-fact:records:list', 'question-sequence:records:list']);
  assert.deepEqual(rights(submit), [
    'answer-fact:records:write', 'follow-up-sequence:records:list', 'owner-action-request:records:write',
    'question-sequence:records:read', 'score-rule:records:list', 'segment-assignment:records:write', 'segment-rule:records:list',
  ]);
  for (const row of [save, submit, results, progress, lines]) assert.equal(row.invoke.internet, false);
});
