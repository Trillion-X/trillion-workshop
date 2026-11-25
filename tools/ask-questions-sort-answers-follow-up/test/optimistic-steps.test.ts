// The step tools behind an optimistic page, on a real Postgres engine (PGlite): the form handed over whole at start (each question
// as first drawn, its check spec, whether it needs the server), an answer that names its question (kept once when sent twice,
// refused when out of order), and answers sent together in order. Every email is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { answerFormQuestion, sittingNext, startSitting } from '../steps/form-page-steps.ts';
import { validateAnswer } from '../read-data/validate-answer.ts';
import { sqlStore, type Store } from '../steps/store.ts';

const FORM_ROWS = `create table form_rows (id text primary key, type text not null, value jsonb not null, kept_at timestamptz not null default now())`;
const FORM = {
  kind: 'question-sequence', formId: 'check-form', title: 'Check form',
  questions: [
    { questionId: 'hours', label: 'Hours a week', questionTypeId: 'number', required: true },
    { questionId: 'ready', label: 'Ready?', questionTypeId: 'picks', required: true, options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
    { questionId: 'why', label: 'Why not?', questionTypeId: 'long-text', required: true, showWhen: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'ready', operator: 'has_any_of', params: { values: ['no'] } }] } },
  ],
};
const ROWS: [string, string, unknown][] = [
  ['question-sequence:check-form', 'question-sequence', FORM],
  ['form-page:check', 'form-page', { kind: 'form-page', slug: 'check', formId: 'check-form', live: true, around: { before: [], after: ['result'] }, keep_at: 'https://app.example.test/', words: { intro_title: 'Check' } }],
  ['form-page:shut', 'form-page', { kind: 'form-page', slug: 'shut', formId: 'check-form', live: false, around: { before: [], after: ['result'] } }],
  ['score-rule:check-form:ready', 'score-rule', { kind: 'score-rule', formId: 'check-form', readKey: 'ready', match: { value_map: { yes: 10, no: 0 } } }],
  ['score-rule:check-form:hours', 'score-rule', { kind: 'score-rule', formId: 'check-form', readKey: 'hours', points: 5, match: { gte: 10 } }],
  ['segment-rule:check-form:a', 'segment-rule', { kind: 'segment-rule', formId: 'check-form', min: 15, segmentId: 'a', title: 'A', meaning: 'Ready now.' }],
  ['segment-rule:check-form:b', 'segment-rule', { kind: 'segment-rule', formId: 'check-form', min: 10, segmentId: 'b', title: 'B' }],
  ['segment-rule:check-form:c', 'segment-rule', { kind: 'segment-rule', formId: 'check-form', min: 0, segmentId: 'c', title: 'C' }],
  ['follow-up-sequence:check-form:a', 'follow-up-sequence', { kind: 'follow-up-sequence', formId: 'check-form', segmentId: 'a', steps: [{ stepId: 'call', label: 'Book a call' }] }],
];

// The tool's own sqlStore over PGlite, so the statements are the ones the tool sends.
async function freshDb(): Promise<{ db: PGlite; store: Store; ids: () => string }> {
  const db = new PGlite();
  await db.exec(FORM_ROWS);
  for (const [id, type, value] of ROWS) await db.query('INSERT INTO form_rows (id, type, value) VALUES ($1, $2, $3)', [id, type, JSON.stringify(value)]);
  const store = sqlStore({ execute: async (sql, params = []) => (await db.query(sql, params)).rows as Record<string, unknown>[] });
  let n = 0;
  return { db, store, ids: () => `s${(n += 1)}` };
}
const rowsOf = async (db: PGlite, type: string, respondent: string) => (await db.query('SELECT id, value FROM form_rows WHERE type = $1 AND value ->> \'respondentId\' = $2 ORDER BY id', [type, respondent])).rows as { id: string; value: any }[];
const clock = (ids: () => string) => ({ newId: ids });
const kept = async (db: PGlite, id: string) => (await db.query('SELECT value ->> \'questionId\' AS question, value -> \'value\' AS value FROM form_rows WHERE type = \'answer-fact\' AND value ->> \'submissionId\' = $1 ORDER BY 1', [id])).rows;

test('start hands over the whole form: each question as first drawn, its check, and whether it needs the server', async () => {
  const { store, ids } = await freshDb();
  const started = await startSitting(store, { slug: 'check' }, clock(ids));
  const { questions } = started.form;
  assert.deepEqual(questions.map(question => question.next?.question?.questionId), ['hours', 'ready', 'why']);
  assert.deepEqual(questions.map(question => question.conditional), [false, false, true]);
  assert.equal(questions[0]!.check.coerce, 'number');
  assert.equal(questions[0]!.check.rules.required, true);
  assert.deepEqual(questions[1]!.check.options?.map(option => option.value), ['yes', 'no']);
  // The page's check and the tool's check are one: the spec is enough to pass or refuse an answer the way the tool does.
  assert.equal(validateAnswer('twelve', questions[0]!.check.coerce, questions[0]!.check.rules, questions[0]!.check).ok, false);
  assert.equal(validateAnswer('12', questions[0]!.check.coerce, questions[0]!.check.rules, questions[0]!.check).ok, true);
  await assert.rejects(answerFormQuestion(store, { attemptId: started.attemptId, value: 'twelve', questionId: 'hours' }), /valid|number|Enter/i);
  assert.equal((await sittingNext(store, { attemptId: started.attemptId })).form?.questions.length, 3);
});

test('an answer that names its question is kept for it; the same answer sent again is kept once and answers the same', async () => {
  const { db, store, ids } = await freshDb();
  const started = await startSitting(store, { slug: 'check' }, clock(ids));
  const first = await answerFormQuestion(store, { attemptId: started.attemptId, value: '12', questionId: 'hours' });
  assert.equal(first.answered, 'hours');
  assert.equal(first.next?.key, 'question:1');
  const again = await answerFormQuestion(store, { attemptId: started.attemptId, value: '12', questionId: 'hours' });
  assert.deepEqual(again, { answered: 'hours', next: first.next });
  assert.equal((await kept(db, started.attemptId)).length, 1);
});

test('an answer for a question the sitting is not waiting at is refused unless it repeats the one kept; it is never kept for another question', async () => {
  const { db, store, ids } = await freshDb();
  const started = await startSitting(store, { slug: 'check' }, clock(ids));
  await answerFormQuestion(store, { attemptId: started.attemptId, value: '12', questionId: 'hours' });
  // A different value for a question already kept, a question not reached yet and a question the form does not have.
  await assert.rejects(answerFormQuestion(store, { attemptId: started.attemptId, value: '30', questionId: 'hours' }), /out of order/);
  await assert.rejects(answerFormQuestion(store, { attemptId: started.attemptId, value: { picked: ['no'] }, questionId: 'why' }), /out of order/);
  await assert.rejects(answerFormQuestion(store, { attemptId: started.attemptId, value: 'x', questionId: 'nothing' }), /out of order/);
  assert.deepEqual((await kept(db, started.attemptId)).map(row => [row.question, row.value]), [['hours', 12]]);
});

test('answers sent together are kept one after the other; the first refused ends the call and the ones before it stay kept', async () => {
  const { db, store, ids } = await freshDb();
  const started = await startSitting(store, { slug: 'check' }, clock(ids));
  const both = await answerFormQuestion(store, { attemptId: started.attemptId, answers: [{ questionId: 'hours', value: '12' }, { questionId: 'ready', value: { picked: ['no'] } }] });
  assert.equal(both.answered, 'ready');
  assert.equal(both.next?.key, 'question:2');
  const next = await startSitting(store, { slug: 'check' }, clock(ids));
  await assert.rejects(answerFormQuestion(store, { attemptId: next.attemptId, answers: [{ questionId: 'hours', value: '9' }, { questionId: 'ready', value: { picked: ['maybe'] } }, { questionId: 'why', value: 'x' }] }));
  assert.deepEqual((await kept(db, next.attemptId)).map(row => row.question), ['hours']);
  await assert.rejects(answerFormQuestion(store, { attemptId: next.attemptId, answers: [] }), /no question/i);
  // The closing page sends what it still holds, including an answer already kept: that changes nothing.
  const closing = await answerFormQuestion(store, { attemptId: next.attemptId, answers: [{ questionId: 'hours', value: '9' }, { questionId: 'ready', value: { picked: ['yes'] } }] });
  assert.equal(closing.answered, 'ready');
  assert.deepEqual((await kept(db, next.attemptId)).map(row => row.question), ['hours', 'ready']);
});
