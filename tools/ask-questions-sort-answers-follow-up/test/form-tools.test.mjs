// The form tools against a real PostgreSQL server: a form is kept as one row, answers and their decision are kept together, the
// readers read what is kept, and each shipped row runs as the engine runs it (its packed files laid under one folder, the held
// connection on descriptor 3, no records door).
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runRowIn, runSqlDescriptor, startDatabase } from '../../workflows/test-helpers/rows-in-sql.mjs';
import { readAnswerLines, readAnswerProgress, readFormResults, saveForm, submitFormAnswers } from '../do-work/form-tools.mjs';

const rowOf = (file, id) => file.records.find(record => record.payload.id === id).payload;
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const sqlFolder = new URL('../sql/', import.meta.url).pathname;
const ids = ['tool:save-a-form', 'tool:submit-form-answers', 'tool:read-form-results', 'tool:read-answer-progress', 'tool:read-latest-answers-as-lines'];

let db;
before(async () => { db = await startDatabase({ sqlFolders: [sqlFolder] }); });
after(async () => { await db.stop(); });
beforeEach(async () => { await db.reset(); });

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
  ['score_rule', 'score-rule:budget', { kind: 'score-rule', readKey: 'budget', match: { gte: 1000 }, points: 10 }],
  ['score_rule', 'score-rule:email', { kind: 'score-rule', readKey: 'email', match: { has_value: true }, points: 12 }],
  ['segment_rule', 'segment-rule:cold', { kind: 'segment-rule', min: 0, segmentId: 'cold' }],
  ['segment_rule', 'segment-rule:hot', { kind: 'segment-rule', min: 20, segmentId: 'hot' }],
  ['follow_up_sequence', 'follow-up-sequence:hot', { kind: 'follow-up-sequence', segmentId: 'hot', steps: [{ stepId: 'call', label: 'Call back' }] }],
];

const ctx = () => ({ sql: db.sql });
const save = (input = form) => saveForm({ input }, ctx());
const submit = input => submitFormAnswers({ input }, ctx());
async function keepRules() {
  for (const [table, id, value] of rules) await db.sql(`insert into ${table} (id, value) values ($1, $2::jsonb)`, [id, JSON.stringify(value)]);
}
const count = async table => Number((await db.sql(`select count(*)::int as n from ${table}`))[0].n);

test('a saved form is one question_sequence row, the same form_id replaces it, and a question with no type is refused', async () => {
  const saved = await save();
  assert.deepEqual([saved.form_id, saved.record_id, saved.question_count], ['intake', 'question-sequence:intake', 3]);
  const [row] = await db.sql('select id, form_id, value from question_sequence');
  assert.deepEqual([row.id, row.form_id, row.value.kind, row.value.questions.length], ['question-sequence:intake', 'intake', 'question-sequence', 3]);
  await save({ ...form, title: 'Intake, second draft' });
  assert.equal(await count('question_sequence'), 1);
  assert.equal((await db.sql('select value from question_sequence'))[0].value.title, 'Intake, second draft');
  await assert.rejects(save({ form_id: 'intake', questions: [{ label: 'no id' }] }), /questions\[0\] needs a questionId and a questionTypeId/);
});

test('answers that fail the form are refused with the first to fix, and nothing is kept', async () => {
  await save();
  const ran = await submit({ form_id: 'intake', respondent_id: 'r1', answers: { budget: 'a lot' } });
  assert.equal(ran.accepted, false);
  assert.equal(ran.first_invalid, 'budget');
  assert.equal(ran.records, undefined);
  assert.equal(await count('answer_fact') + await count('segment_assignment'), 0);
});

test('a valid submission keeps its facts and its decision together, reading the rules from the tables', async () => {
  await save();
  await keepRules();
  const answers = { budget: '2000', email: 'user-ebb18a03@example.com', focus: 8, stray: 'not in the form' };
  const ran = await submit({ form_id: 'intake', respondent_id: 'r1', answers, answered_at: '2026-06-26T00:00:00Z' });
  assert.equal(ran.accepted, true);
  assert.equal(ran.decision.segmentId, 'hot');
  assert.equal(ran.decision.score, 22);
  assert.equal(ran.follow_up.steps[0].label, 'Call back');
  assert.deepEqual(ran.ignored, ['stray']);
  assert.deepEqual((await db.sql('select id from answer_fact order by id')).map(row => row.id), ['answer-fact:intake:r1:budget', 'answer-fact:intake:r1:email', 'answer-fact:intake:r1:focus']);
  assert.equal((await db.sql("select value from answer_fact where id = 'answer-fact:intake:r1:budget'"))[0].value.value, 2000, 'a number answer is kept as a number');
  const [assignment] = await db.sql('select id, form_id, respondent_id, value from segment_assignment');
  assert.deepEqual([assignment.id, assignment.form_id, assignment.respondent_id, assignment.value.segmentId], ['segment-assignment:intake:r1', 'intake', 'r1', 'hot']);
  await submit({ form_id: 'intake', respondent_id: 'r1', answers, answered_at: '2026-06-26T00:00:00Z' });
  assert.equal(await count('answer_fact'), 3, 'answering again with no submission_id replaces, never doubles');
});

test('a submission to a form the database does not hold is refused and keeps nothing', async () => {
  await keepRules();
  await assert.rejects(submit({ form_id: 'intake', respondent_id: 'r1', answers: {} }), /The database holds no form intake/);
  assert.equal(await count('answer_fact') + await count('segment_assignment'), 0);
});

test('a question\'s after-saved hand-off is kept as a request row for its owner', async () => {
  await save({ ...form, form_id: 'with-handoff', questions: [{ questionId: 'goal', questionTypeId: 'text', label: 'Goal', afterSaved: { owner: 'tasks', actionRef: 'action:create-task', input: { title: '$answer.goal', for: '$run.scope_ref' } } }] });
  const ran = await submit({ form_id: 'with-handoff', respondent_id: 'r2', submission_id: 's1', answers: { goal: 'Plan the week' }, answered_at: '2026-06-26T00:00:00Z' });
  const [request] = await db.sql('select id, status, form_id, value from owner_action_request');
  assert.equal(request.value.owner, 'tasks');
  assert.deepEqual(request.value.input, { title: 'Plan the week', for: 'r2' });
  assert.deepEqual([request.status, request.form_id], ['requested', 'with-handoff']);
  assert.deepEqual(ran.action_requests.map(item => [item.id, item.actionRef]), [[request.id, 'action:create-task']]);
});

async function answered(respondent, answers, at, extra = {}) {
  await submit({ form_id: 'intake', respondent_id: respondent, answers: { email: 'user-ebb18a03@example.com', ...answers }, answered_at: at, ...extra });
}

test('results list each respondent\'s segment from the kept assignments, newest first, with a count per segment', async () => {
  await save();
  await keepRules();
  await answered('r1', { budget: 2000 }, '2026-06-26T00:00:00Z');
  await answered('r2', { budget: 10 }, '2026-06-27T00:00:00Z');
  const ran = await readFormResults({ input: { form_id: 'intake' } }, ctx());
  assert.deepEqual(ran.rows.map(row => [row.respondentId, row.segmentId]), [['r2', 'cold'], ['r1', 'hot']]);
  assert.deepEqual(ran.summary, { total: 2, bySegment: { cold: 1, hot: 1 } });
  assert.deepEqual((await readFormResults({ input: { form_id: 'another-form' } }, ctx())), { rows: [], summary: { total: 0, bySegment: {} } }, 'nothing is shown until someone answers');
});

test('progress folds one respondent\'s sessions into ordered rows and a trend', async () => {
  await save();
  await keepRules();
  await answered('r1', { budget: 1, focus: 4 }, '2026-06-20T18:00:00Z', { submission_id: 's1' });
  await answered('r1', { budget: 1, focus: 8 }, '2026-06-27T18:00:00Z', { submission_id: 's2' });
  await answered('r2', { budget: 1, focus: 1 }, '2026-06-28T18:00:00Z', { submission_id: 's3' });
  const ran = await readAnswerProgress({ input: { form_id: 'intake', respondent_id: 'r1', field_map: { focus: 'focus' } } }, ctx());
  assert.deepEqual(ran.rows.map(row => row.fields.focus), [4, 8]);
  assert.deepEqual(ran.trend, { field: 'focus', points: [4, 8] });
  assert.equal(ran.count, 2);
});

test('the latest answers read back as lines, each labelled with its question', async () => {
  await save();
  await keepRules();
  await answered('r1', { budget: 5 }, '2026-06-26T00:00:00Z');
  const ran = await readAnswerLines({ input: { form_id: 'intake', respondent_id: 'r1' } }, ctx());
  assert.deepEqual([...ran.lines].sort(), ['Budget: 5', 'Email: user-ebb18a03@example.com']);
});

test('each shipped row keeps rows in SQL and nothing else: no records door, the held connection on descriptor 3, the pinned pg libraries', () => {
  const runSql = runSqlDescriptor();
  const pgFiles = runSql.invoke.files.package_files.filter(spec => spec.packages);
  for (const id of ids) {
    const { invoke, verify } = rowOf(rows, id);
    assert.equal(invoke.records, undefined, `${id} declares no records door`);
    assert.equal(invoke.internet, false, id);
    assert.deepEqual(invoke.local_doors, ['own-rows-postgres'], id);
    assert.deepEqual(invoke.credential_mounts, [{ secret_name: 'own-rows-postgres-connection', fd: 3 }], id);
    assert.deepEqual(invoke.packages, runSql.invoke.packages, id);
    assert.deepEqual(invoke.files.package_files.filter(spec => spec.packages), pgFiles, id);
    assert.ok(!invoke.files.package_files.some(spec => spec.package === 'records-door'), `${id} packs no records door`);
    assert.deepEqual(verify.map(item => item.kind), ['needs-a-machine'], id);
  }
  for (const id of ids.slice(1)) assert.ok(!(rowOf(rows, id).input_schema.required ?? []).includes('records'), `${id} takes no records`);
});

test('each shipped row runs as the engine runs it, with its packed files laid and the connection on descriptor 3', async () => {
  const run = (id, input) => runRowIn(rowOf(rows, id), { input, task: { request_key: 'k' } }, { connection: db.connection });
  const saved = await run('tool:save-a-form', form);
  assert.equal(saved.code, 0, saved.stderr + saved.out);
  assert.equal(saved.last.result.record_id, 'question-sequence:intake');
  await keepRules();
  const submitted = await run('tool:submit-form-answers', { form_id: 'intake', respondent_id: 'r1', answers: { budget: '2000', email: 'user-ebb18a03@example.com' }, answered_at: '2026-06-26T00:00:00Z' });
  assert.equal(submitted.code, 0, submitted.stderr + submitted.out);
  assert.equal(submitted.last.result.decision.segmentId, 'hot');
  const results = await run('tool:read-form-results', { form_id: 'intake' });
  assert.deepEqual(results.last.result.summary, { total: 1, bySegment: { hot: 1 } });
  const progress = await run('tool:read-answer-progress', { form_id: 'intake', respondent_id: 'r1', field_map: { budget: 'budget' } });
  assert.equal(progress.last.result.count, 1);
  const lines = await run('tool:read-latest-answers-as-lines', { form_id: 'intake', respondent_id: 'r1' });
  assert.deepEqual([...lines.last.result.lines].sort(), ['Budget: 2000', 'Email: user-ebb18a03@example.com']);
});
