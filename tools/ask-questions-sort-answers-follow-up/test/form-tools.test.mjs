// The form tools as functions of their input: a form is one question-sequence row to keep, answers and their decision are
// rows to keep together, the readers read the rows they are given, and each shipped row runs as the engine runs it with no
// door and no held value. The person's own database is stood in for by one Map of rows, which every call is given and which
// takes what each answer says to keep.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerOf } from '../../../test-helpers/run-a-row.mjs';
import { readAnswerLines, readAnswerProgress, readFormResults, saveForm, submitFormAnswers } from '../do-work/form-tools.mjs';

const rowOf = (file, id) => file.records.find(record => record.payload.id === id).payload;
const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
const ids = ['tool:save-a-form', 'tool:submit-form-answers', 'tool:read-form-results', 'tool:read-answer-progress', 'tool:read-latest-answers-as-lines'];

let kept;
beforeEach(() => { kept = new Map(); });
const given = () => [...kept.values()];
const keep = answer => { for (const row of answer.keep ?? []) kept.set(row.id, structuredClone(row)); return answer; };
const ofKind = kind => given().filter(row => row.type === kind).sort((a, b) => (a.id < b.id ? -1 : 1));

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
  ['score-rule', 'score-rule:budget', { kind: 'score-rule', readKey: 'budget', match: { gte: 1000 }, points: 10 }],
  ['score-rule', 'score-rule:email', { kind: 'score-rule', readKey: 'email', match: { has_value: true }, points: 12 }],
  ['segment-rule', 'segment-rule:cold', { kind: 'segment-rule', min: 0, segmentId: 'cold' }],
  ['segment-rule', 'segment-rule:hot', { kind: 'segment-rule', min: 20, segmentId: 'hot' }],
  ['follow-up-sequence', 'follow-up-sequence:hot', { kind: 'follow-up-sequence', segmentId: 'hot', steps: [{ stepId: 'call', label: 'Call back' }] }],
];

const save = async (input = form) => keep(await saveForm(input));
const submit = async input => keep(await submitFormAnswers({ ...input, rows: given() }));
const keepRules = () => { for (const [type, id, value] of rules) kept.set(id, { id, type, value }); };

test('a saved form is one question-sequence row to keep, the same form_id replaces it, and a question with no type is refused', async () => {
  const saved = await save();
  assert.deepEqual([saved.form_id, saved.record_id, saved.question_count], ['intake', 'question-sequence:intake', 3]);
  const [row] = ofKind('question-sequence');
  assert.deepEqual([row.id, row.value.formId, row.value.kind, row.value.questions.length], ['question-sequence:intake', 'intake', 'question-sequence', 3]);
  await save({ ...form, title: 'Intake, second draft' });
  assert.equal(ofKind('question-sequence').length, 1);
  assert.equal(ofKind('question-sequence')[0].value.title, 'Intake, second draft');
  await assert.rejects(saveForm({ form_id: 'intake', questions: [{ label: 'no id' }] }), /questions\[0\] needs a questionId and a questionTypeId/);
});

test('answers that fail the form are refused with the first to fix, and nothing is to keep', async () => {
  await save();
  const ran = await submit({ form_id: 'intake', respondent_id: 'r1', answers: { budget: 'a lot' } });
  assert.equal(ran.accepted, false);
  assert.equal(ran.first_invalid, 'budget');
  assert.equal(ran.keep, undefined);
  assert.equal(ofKind('answer-fact').length + ofKind('segment-assignment').length, 0);
});

test('a valid submission answers its facts and its decision together, reading the rules from the rows given', async () => {
  await save();
  keepRules();
  const answers = { budget: '2000', email: 'user-ebb18a03@example.com', focus: 8, stray: 'not in the form' };
  const ran = await submit({ form_id: 'intake', respondent_id: 'r1', answers, answered_at: '2026-06-26T00:00:00Z' });
  assert.equal(ran.accepted, true);
  assert.equal(ran.decision.segmentId, 'hot');
  assert.equal(ran.decision.score, 22);
  assert.equal(ran.follow_up.steps[0].label, 'Call back');
  assert.deepEqual(ran.ignored, ['stray']);
  assert.deepEqual(ofKind('answer-fact').map(row => row.id), ['answer-fact:intake:r1:budget', 'answer-fact:intake:r1:email', 'answer-fact:intake:r1:focus']);
  assert.equal(kept.get('answer-fact:intake:r1:budget').value.value, 2000, 'a number answer is kept as a number');
  const [assignment] = ofKind('segment-assignment');
  assert.deepEqual([assignment.id, assignment.value.formId, assignment.value.respondentId, assignment.value.segmentId], ['segment-assignment:intake:r1', 'intake', 'r1', 'hot']);
  await submit({ form_id: 'intake', respondent_id: 'r1', answers, answered_at: '2026-06-26T00:00:00Z' });
  assert.equal(ofKind('answer-fact').length, 3, 'answering again with no submission_id replaces, never doubles');
});

test('a submission to a form the rows do not hold is refused, and rows that are not rows are refused', async () => {
  keepRules();
  await assert.rejects(submit({ form_id: 'intake', respondent_id: 'r1', answers: {} }), /The rows given hold no form intake/);
  assert.equal(ofKind('answer-fact').length + ofKind('segment-assignment').length, 0);
  await assert.rejects(submitFormAnswers({ form_id: 'intake', respondent_id: 'r1', answers: {}, rows: [{ id: 'x' }] }), /rows must be/);
});

test('a question\'s after-saved hand-off is answered as a request row for its owner', async () => {
  await save({ ...form, form_id: 'with-handoff', questions: [{ questionId: 'goal', questionTypeId: 'text', label: 'Goal', afterSaved: { owner: 'tasks', actionRef: 'action:create-task', input: { title: '$answer.goal', for: '$run.scope_ref' } } }] });
  const ran = await submit({ form_id: 'with-handoff', respondent_id: 'r2', submission_id: 's1', answers: { goal: 'Plan the week' }, answered_at: '2026-06-26T00:00:00Z' });
  const [request] = ofKind('owner-action-request');
  assert.equal(request.value.owner, 'tasks');
  assert.deepEqual(request.value.input, { title: 'Plan the week', for: 'r2' });
  assert.deepEqual([request.value.status, request.value.formId], ['requested', 'with-handoff']);
  assert.deepEqual(ran.action_requests.map(item => [item.id, item.actionRef]), [[request.id, 'action:create-task']]);
});

async function answered(respondent, answers, at, extra = {}) {
  await submit({ form_id: 'intake', respondent_id: respondent, answers: { email: 'user-ebb18a03@example.com', ...answers }, answered_at: at, ...extra });
}

test('results list each respondent\'s segment from the given assignments, newest first, with a count per segment', async () => {
  await save();
  keepRules();
  await answered('r1', { budget: 2000 }, '2026-06-26T00:00:00Z');
  await answered('r2', { budget: 10 }, '2026-06-27T00:00:00Z');
  const ran = await readFormResults({ form_id: 'intake', rows: given() });
  assert.deepEqual(ran.rows.map(row => [row.respondentId, row.segmentId]), [['r2', 'cold'], ['r1', 'hot']]);
  assert.deepEqual(ran.summary, { total: 2, bySegment: { cold: 1, hot: 1 } });
  assert.deepEqual((await readFormResults({ form_id: 'another-form', rows: given() })), { rows: [], summary: { total: 0, bySegment: {} } }, 'nothing is shown until someone answers');
});

test('progress folds one respondent\'s sessions into ordered rows and a trend', async () => {
  await save();
  keepRules();
  await answered('r1', { budget: 1, focus: 4 }, '2026-06-20T18:00:00Z', { submission_id: 's1' });
  await answered('r1', { budget: 1, focus: 8 }, '2026-06-27T18:00:00Z', { submission_id: 's2' });
  await answered('r2', { budget: 1, focus: 1 }, '2026-06-28T18:00:00Z', { submission_id: 's3' });
  const ran = await readAnswerProgress({ form_id: 'intake', respondent_id: 'r1', field_map: { focus: 'focus' }, rows: given() });
  assert.deepEqual(ran.rows.map(row => row.fields.focus), [4, 8]);
  assert.deepEqual(ran.trend, { field: 'focus', points: [4, 8] });
  assert.equal(ran.count, 2);
});

test('the latest answers read back as lines, each labelled with its question', async () => {
  await save();
  keepRules();
  await answered('r1', { budget: 5 }, '2026-06-26T00:00:00Z');
  const ran = await readAnswerLines({ form_id: 'intake', respondent_id: 'r1', rows: given() });
  assert.deepEqual([...ran.lines].sort(), ['Budget: 5', 'Email: user-ebb18a03@example.com']);
});

test('each shipped row reaches nothing: no records door, no database door, no held value, no packages', () => {
  for (const id of ids) {
    const { invoke } = rowOf(rows, id);
    assert.equal(invoke.records, undefined, `${id} declares no records door`);
    assert.equal(invoke.may_reach, undefined, id);
    assert.equal(invoke.local_doors, undefined, id);
    assert.equal(invoke.key, undefined, id);
    assert.equal(invoke.packages, undefined, id);
    assert.ok(!invoke.files.package_files.some(spec => spec.package === 'records-door' || spec.packages), `${id} packs no door and no package`);
  }
});

test('each shipped row runs as the engine runs it, with its packed files laid, given rows and answering rows to keep', async () => {
  const run = async (id, input) => { const answer = await answerOf(rowOf(rows, id), { ...input, rows: given() }); assert.equal(answer.status, 0, answer.error); keep(answer.result); return answer.result; };
  assert.equal((await run('tool:save-a-form', form)).record_id, 'question-sequence:intake');
  keepRules();
  const submitted = await run('tool:submit-form-answers', { form_id: 'intake', respondent_id: 'r1', answers: { budget: '2000', email: 'user-ebb18a03@example.com' }, answered_at: '2026-06-26T00:00:00Z' });
  assert.equal(submitted.decision.segmentId, 'hot');
  assert.deepEqual((await run('tool:read-form-results', { form_id: 'intake' })).summary, { total: 1, bySegment: { hot: 1 } });
  assert.equal((await run('tool:read-answer-progress', { form_id: 'intake', respondent_id: 'r1', field_map: { budget: 'budget' } })).count, 1);
  assert.deepEqual([...(await run('tool:read-latest-answers-as-lines', { form_id: 'intake', respondent_id: 'r1' })).lines].sort(), ['Budget: 2000', 'Email: user-ebb18a03@example.com']);
});
