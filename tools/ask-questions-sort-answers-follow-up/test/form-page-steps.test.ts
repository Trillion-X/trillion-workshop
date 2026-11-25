// A form page on a real Postgres engine (PGlite): answered first as the sitting itself, its result from the form's rules, kept under
// the email the sign-in proved (its facts move to the person, its decision written with them), kept once only, and a signed-in
// member answering as themselves. The store is the tool's own sqlStore over PGlite, so the statements are the ones the tool sends.
// Every email is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { answerFormQuestion, formResult, keepSitting, loadFormPage, sittingNext, startSitting } from '../steps/form-page-steps.ts';
import { committer } from '../steps/serve-steps.ts';
import { sqlStore, type Store } from '../steps/store.ts';

const FORM_ROWS = `create table form_rows (id text primary key, type text not null, value jsonb not null, kept_at timestamptz not null default now())`;
const EMAIL = 'invented.player@example.test';
const OTHER = 'someone.else@example.test';
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

// The store's statements against PGlite; the committer's dry run and real run are both honoured as the batch runner does
// (each statement under a savepoint, `refused` counting those the database refused).
async function freshDb(): Promise<{ db: PGlite; store: Store; ids: () => string }> {
  const db = new PGlite();
  await db.exec(FORM_ROWS);
  for (const [id, type, value] of ROWS) await db.query('INSERT INTO form_rows (id, type, value) VALUES ($1, $2, $3)', [id, type, JSON.stringify(value)]);
  const run = (async ({ input }: { input: { statements: { sql: string; params: unknown[] }[]; then: string } }) => {
    await db.query('BEGIN');
    let refused = 0;
    for (const { sql, params } of input.statements) {
      await db.query('SAVEPOINT each_statement');
      try { await db.query(sql, params); await db.query('RELEASE SAVEPOINT each_statement'); } catch { refused += 1; await db.query('ROLLBACK TO SAVEPOINT each_statement'); }
    }
    await db.query(input.then === 'commit' ? 'COMMIT' : 'ROLLBACK');
    return { refused };
  }) as never;
  const store = sqlStore({ execute: async (sql, params = []) => (await db.query(sql, params)).rows as Record<string, unknown>[], commit: committer('unused', run) });
  let n = 0;
  return { db, store, ids: () => `s${(n += 1)}` };
}
const rowsOf = async (db: PGlite, type: string, respondent: string) => (await db.query('SELECT id, value FROM form_rows WHERE type = $1 AND value ->> \'respondentId\' = $2 ORDER BY id', [type, respondent])).rows as { id: string; value: any }[];
const clock = (ids: () => string) => ({ newId: ids });

test('a page that is not live, or names no row, is closed', async () => {
  const { store } = await freshDb();
  await assert.rejects(loadFormPage(store, 'shut'), /not open/);
  await assert.rejects(loadFormPage(store, 'nothing'), /not open/);
  assert.equal((await loadFormPage(store, 'check')).questions.length, 3);
});

test('a visitor answers first as the sitting itself; a question asked only when its rules hold is passed by', async () => {
  const { db, store, ids } = await freshDb();
  const started = await startSitting(store, { slug: 'check' }, clock(ids));
  assert.equal(started.next?.key, 'question:0');
  const second = await answerFormQuestion(store, { attemptId: started.attemptId, value: '12' });
  assert.equal(second.next?.key, 'question:1');
  const done = await answerFormQuestion(store, { attemptId: started.attemptId, value: { picked: ['yes'] } });
  assert.equal(done.next?.key, 'result');
  assert.equal((await rowsOf(db, 'answer-fact', `visitor:${started.attemptId}`)).length, 2);
  assert.deepEqual(await sittingNext(store, { attemptId: started.attemptId }), { kept: false, next: { key: 'result', kind: 'result' } });
});

test('the same question answered again replaces its answer; a refused answer keeps nothing and does not repeat the value', async () => {
  const { db, store, ids } = await freshDb();
  const { attemptId } = await startSitting(store, { slug: 'check' }, clock(ids));
  await assert.rejects(answerFormQuestion(store, { attemptId, value: 'many' }), (error: Error) => !error.message.includes('many'));
  assert.equal((await rowsOf(db, 'answer-fact', `visitor:${attemptId}`)).length, 0);
  await answerFormQuestion(store, { attemptId, value: '12' });
  assert.equal((await rowsOf(db, 'answer-fact', `visitor:${attemptId}`)).length, 1);
  await assert.rejects(answerFormQuestion(store, { attemptId: 'nothing', value: '1' }), /not known/);
});

test('the result is the form rules\' segment with its follow-up; it is not kept until an email is proven', async () => {
  const { db, store, ids } = await freshDb();
  const { attemptId } = await startSitting(store, { slug: 'check' }, clock(ids));
  await assert.rejects(formResult(store, { attemptId }), /Answer every question/);
  await answerFormQuestion(store, { attemptId, value: '12' });
  await answerFormQuestion(store, { attemptId, value: { picked: ['yes'] } });
  const result = await formResult(store, { attemptId });
  assert.deepEqual(result.segment, { id: 'a', title: 'A', meaning: 'Ready now.', next_step: null });
  assert.deepEqual(result.follow_up, [{ id: 'call', label: 'Book a call' }]);
  assert.equal(result.kept, false);
  assert.equal(((await db.query("SELECT count(*)::int n FROM form_rows WHERE type = 'segment-assignment'")).rows[0] as { n: number }).n, 0);
});

test('keeping moves the facts to the proven email and writes the decision; again changes nothing; another email is refused', async () => {
  const { db, store, ids } = await freshDb();
  const { attemptId } = await startSitting(store, { slug: 'check' }, clock(ids));
  await answerFormQuestion(store, { attemptId, value: '3' });
  await answerFormQuestion(store, { attemptId, value: { picked: ['no'] } });
  await answerFormQuestion(store, { attemptId, value: 'Money' });
  await assert.rejects(keepSitting(store, { attemptId, email: null }), (error: Error & { status?: number }) => error.status === 401 && /Sign in/.test(error.message));
  const kept = await keepSitting(store, { attemptId, email: EMAIL });
  assert.deepEqual([kept.kept, kept.segment?.id, kept.keep_at], [true, 'c', 'https://app.example.test/']);
  assert.equal((await rowsOf(db, 'answer-fact', `visitor:${attemptId}`)).length, 0);
  const facts = await rowsOf(db, 'answer-fact', EMAIL);
  assert.deepEqual(facts.map(row => row.id), ['hours', 'ready', 'why'].map(q => `answer-fact:check-form:${EMAIL}:submission:${attemptId}:${q}`).sort());
  assert.equal(facts.find(row => row.value.questionId === 'why')?.value.words, 'Money');
  const [assignment] = await rowsOf(db, 'segment-assignment', EMAIL);
  assert.deepEqual([assignment.id, assignment.value.segmentId, assignment.value.submissionId], [`segment-assignment:check-form:${EMAIL}:submission:${attemptId}`, 'c', attemptId]);
  const again = await keepSitting(store, { attemptId, email: EMAIL });
  assert.equal(again.segment?.id, 'c');
  assert.equal((await rowsOf(db, 'answer-fact', EMAIL)).length, 3);
  await assert.rejects(keepSitting(store, { attemptId, email: OTHER }), (error: Error & { status?: number }) => error.status === 403);
  await assert.rejects(answerFormQuestion(store, { attemptId, value: '1' }), /already kept/);
});

test('a signed-in member answers as themselves; two sittings are two submissions of the same person', async () => {
  const { db, store, ids } = await freshDb();
  for (const [hours, ready] of [['3', 'yes'], ['12', 'yes']]) {
    const { attemptId } = await startSitting(store, { slug: 'check', email: EMAIL }, clock(ids));
    await answerFormQuestion(store, { attemptId, value: hours });
    await answerFormQuestion(store, { attemptId, value: { picked: [ready] } });
    assert.equal((await formResult(store, { attemptId })).kept, true);
    assert.equal((await sittingNext(store, { attemptId })).kept, false);
    await keepSitting(store, { attemptId, email: EMAIL });
    assert.equal((await sittingNext(store, { attemptId })).kept, true);
  }
  assert.deepEqual((await rowsOf(db, 'segment-assignment', EMAIL)).map(row => row.value.segmentId), ['b', 'a']);
  assert.equal((await rowsOf(db, 'answer-fact', EMAIL)).length, 4);
});

test('a write the database refuses keeps nothing of the step: the dry run catches it before anything is committed', async () => {
  const { db, store, ids } = await freshDb();
  const { attemptId } = await startSitting(store, { slug: 'check' }, clock(ids));
  await assert.rejects(store.apply([{ kind: 'insert', id: `form-sitting:${attemptId}`, type: 'form-sitting', value: {} }, { kind: 'upsert', id: 'later', type: 'x', value: {} }]), /Something went wrong/);
  assert.equal(((await db.query("SELECT count(*)::int n FROM form_rows WHERE id = 'later'")).rows[0] as { n: number }).n, 0);
});
