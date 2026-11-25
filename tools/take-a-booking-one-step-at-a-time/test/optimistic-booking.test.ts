// The booking steps behind an optimistic page, on a real Postgres engine (PGlite): the page's questions handed over whole when the
// email opens the booking, answers that name their question (sent twice they are kept once, and together they are kept in order),
// and the step that needs the server's fact, the time chosen, when the time was taken since the times were read. Every email is
// invented and no calendar is called: the busy times are inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { answerBookingQuestion, chooseSlot, readOpenTimes, startBooking } from '../steps/booking-steps.ts';
import { holdSlot, withoutSlot } from '../show/hold-slot.ts';
import { sqlStore, type Store } from '../../ask-questions-sort-answers-follow-up/steps/store.ts';

const DDL = `
  create table form_rows (id text primary key, type text not null, value jsonb not null, kept_at timestamptz not null default now());
  create table booking_pages (slug text primary key, title text not null, duration_minutes integer not null, timezone text not null, calendar_account text not null,
    windows jsonb, horizon_days integer not null default 30, min_notice_minutes integer not null default 0, live boolean not null default false, made_at timestamptz not null default now(), form_id text);
  create table bookings (id text primary key, provider text not null, provider_booking_id text not null, booking_type text not null, starts_at timestamptz not null, ends_at timestamptz not null,
    booker_email text not null, booker_name text, booker_timezone text, status text not null, cancelled_at timestamptz, meeting_link text, calendar_event_ref text, came_from text,
    made_at timestamptz not null, updated_at timestamptz not null default now(), replaces text, form_sitting_id text);
`;
// The calendar tool's whole answer, as a read that succeeded.
const read = (busy: unknown[]) => ({ status: 'read', busy });
const SLUG = 'call';
const EMAIL = 'invented.booker@example.test';
// Monday to Friday, 09:00 to 12:00 in the page's zone. The test clock is a Monday 2026-11-23 06:00 Chicago time (12:00 UTC).
const WINDOWS = [1, 2, 3, 4, 5].map(weekday => ({ weekday, start: '09:00', end: '12:00' }));
const NOW = Date.parse('2026-11-23T12:00:00Z');
const TEN_AM = '2026-11-23T16:00:00.000Z'; // 10:00 Chicago (CST, UTC-6)
const FORM = { kind: 'question-sequence', formId: 'call-form', title: 'Call', questions: [
  { questionId: 'goal', questionTypeId: 'long-text', label: 'What is your goal?', required: true },
  { questionId: 'hours', questionTypeId: 'number', label: 'Hours a week', required: false },
] };

async function freshDb({ live = true }: { live?: boolean } = {}): Promise<{ db: PGlite; store: Store; clock: { nowMs: () => number; newId: () => string } }> {
  const db = new PGlite();
  await db.exec(DDL);
  await db.query('INSERT INTO form_rows (id, type, value) VALUES ($1, $2, $3)', ['question-sequence:call-form', 'question-sequence', JSON.stringify(FORM)]);
  await db.query('INSERT INTO booking_pages (slug, title, duration_minutes, timezone, calendar_account, windows, horizon_days, min_notice_minutes, live, form_id) VALUES ($1, $2, 30, $3, $4, $5, 3, 10, $6, $7)',
    [SLUG, 'A call', 'America/Chicago', 'someone', JSON.stringify(WINDOWS), live, 'call-form']);
  const store = sqlStore({ execute: async (sql, params = []) => (await db.query(sql, params)).rows as Record<string, unknown>[] });
  let n = 0;
  return { db, store, clock: { nowMs: () => NOW, newId: () => `id-${(n += 1)}` } };
}
const sittingValue = async (db: PGlite, id: string) => ((await db.query('SELECT value FROM form_rows WHERE id = $1', [`form-sitting:${id}`])).rows[0] as { value: any }).value;


test('the email opens the booking and hands over the questions with how each answer is checked', async () => {
  const { store, clock } = await freshDb();
  const started = await startBooking(store, { slug: SLUG, email: EMAIL }, clock);
  const { questions } = started.form;
  assert.deepEqual(questions.map(question => question.next?.question?.questionId), ['goal', 'hours']);
  assert.deepEqual(questions.map(question => question.conditional), [false, false]);
  assert.equal(questions[0]!.check.rules.required, true);
  assert.notEqual(questions[1]!.check.rules.required, true);
  assert.equal(questions[1]!.check.coerce, 'number');
});

test('answers that name their question are kept in order; sent again they are kept once, and one out of order is refused', async () => {
  const { db, store, clock } = await freshDb();
  const { attemptId } = await startBooking(store, { slug: SLUG, email: EMAIL }, clock);
  const both = await answerBookingQuestion(store, { attemptId, answers: [{ questionId: 'goal', value: 'Win my league.' }, { questionId: 'hours', value: '' }] }, clock);
  assert.equal(both.next?.key, 'slot');
  assert.deepEqual(await answerBookingQuestion(store, { attemptId, value: 'Win my league.', questionId: 'goal' }, clock), { answered: 'goal', next: both.next });
  await assert.rejects(answerBookingQuestion(store, { attemptId, value: 'Something else.', questionId: 'goal' }, clock), /out of order/);
  const kept = (await db.query("SELECT value ->> 'questionId' AS question FROM form_rows WHERE type = 'answer-fact' ORDER BY 1")).rows.map((row: any) => row.question);
  assert.deepEqual(kept, ['goal', 'hours']);
});

test('a time taken since the times were read is refused with the tool\'s words, kept as chosen by no one, and offered no more', async () => {
  const { db, store, clock } = await freshDb();
  const { attemptId } = await startBooking(store, { slug: SLUG, email: EMAIL }, clock);
  await answerBookingQuestion(store, { attemptId, answers: [{ questionId: 'goal', value: 'Win my league.' }, { questionId: 'hours', value: '' }] }, clock);
  const open = (await readOpenTimes(store, { attemptId, busy_read: read([]) }, clock)).slots;
  assert.ok(open.some(slot => slot.startIso === TEN_AM));
  const taken = open.find(slot => slot.startIso === TEN_AM)!;
  const refused = await holdSlot(() => chooseSlot(store, { attemptId, value: TEN_AM, busy_read: read([{ start: TEN_AM, end: '2026-11-23T16:30:00Z' }]) }, clock), 'Something went wrong.');
  assert.deepEqual(refused, { held: false, message: 'That time is not open.' });
  assert.equal((await sittingValue(db, attemptId)).steps.slot, undefined);
  const left = withoutSlot(open, taken);
  assert.equal(left.length, open.length - 1);
  assert.deepEqual(left, open.filter(slot => slot.startIso !== TEN_AM));
  // Another time still open is held.
  const another = left[0]!;
  assert.deepEqual(await holdSlot(() => chooseSlot(store, { attemptId, value: another.startIso, busy_read: read([]) }, clock), 'Something went wrong.'), { held: true });
  assert.equal((await sittingValue(db, attemptId)).steps.slot, another.startIso);
});

test('a failure with no words of its own is told in the page\'s failed words', async () => {
  assert.deepEqual(await holdSlot(async () => { throw new Error(''); }, 'Something went wrong.'), { held: false, message: 'Something went wrong.' });
  assert.deepEqual(await holdSlot(async () => { throw 'nothing'; }, 'Something went wrong.'), { held: false, message: 'Something went wrong.' });
});
