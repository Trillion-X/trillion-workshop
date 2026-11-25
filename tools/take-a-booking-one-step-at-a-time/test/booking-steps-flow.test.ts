// A booking, step by step, on a real Postgres engine (PGlite) through the tools' own sqlStore: the email, the form's questions, the
// open times from the busy times given, the chosen time, the event the calendar tool is asked to make, and the booking row kept.
// No calendar is called anywhere: the busy times and the made event are inputs. Every email is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { answerBookingQuestion, busyOf, checkBookingReady, chooseSlot, keepBooking, loadLivePage, readOpenTimes, startBooking } from '../steps/booking-steps.ts';
import { committer } from '../../ask-questions-sort-answers-follow-up/steps/serve-steps.ts';
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
  return { db, store, clock: { nowMs: () => NOW, newId: () => `id-${(n += 1)}` } };
}
const sittingValue = async (db: PGlite, id: string) => ((await db.query('SELECT value FROM form_rows WHERE id = $1', [`form-sitting:${id}`])).rows[0] as { value: any }).value;

async function toTheSlotStep(store: Store, clock: { nowMs: () => number; newId: () => string }) {
  const { attemptId } = await startBooking(store, { slug: SLUG, email: EMAIL }, clock);
  await answerBookingQuestion(store, { attemptId, value: 'Win my league.' }, clock);
  const last = await answerBookingQuestion(store, { attemptId, value: '' }, clock);
  assert.equal(last.next?.key, 'slot');
  return attemptId;
}

test('a page that is not live, has no windows or no form is not offered', async () => {
  const { db, store } = await freshDb({ live: false });
  await assert.rejects(loadLivePage(store, SLUG), /not open/);
  await db.query('UPDATE booking_pages SET live = true, windows = $2 WHERE slug = $1', [SLUG, '[]']);
  await assert.rejects(loadLivePage(store, SLUG), /no times to offer/);
  await db.query('UPDATE booking_pages SET windows = $2, form_id = $3 WHERE slug = $1', [SLUG, JSON.stringify(WINDOWS), 'missing']);
  await assert.rejects(loadLivePage(store, SLUG), /no questions/);
});

test('the email opens the sitting and the first question follows; a bad email is refused without repeating it', async () => {
  const { db, store, clock } = await freshDb();
  await assert.rejects(startBooking(store, { slug: SLUG, email: 'not-an-email' }, clock), (error: Error) => !error.message.includes('not-an-email'));
  const started = await startBooking(store, { slug: SLUG, email: EMAIL }, clock);
  assert.equal(started.next?.key, 'question:0');
  assert.deepEqual([(await sittingValue(db, started.attemptId)).respondentId, (await sittingValue(db, started.attemptId)).status], [EMAIL, 'started']);
  const second = await answerBookingQuestion(store, { attemptId: started.attemptId, value: 'Win my league.' }, clock);
  assert.equal(second.next?.key, 'question:1');
  assert.equal((await answerBookingQuestion(store, { attemptId: started.attemptId, value: '' }, clock)).next?.key, 'slot');
});

test('the open times are the windows minus the busy times given; a missing read is refused, never taken for a free calendar', async () => {
  const { store, clock } = await freshDb();
  const attemptId = await toTheSlotStep(store, clock);
  await assert.rejects(readOpenTimes(store, { attemptId, busy_read: undefined }, clock), /Give busy_read/);
  await assert.rejects(readOpenTimes(store, { attemptId, busy_read: read([{ start: 'later', end: 'soon' }]) }, clock), /not understood/);
  const free = (await readOpenTimes(store, { attemptId, busy_read: read([]) }, clock)).slots;
  assert.ok(free.some(slot => slot.startIso === TEN_AM));
  const busy = [{ start: '2026-11-23T16:00:00Z', end: '2026-11-23T16:30:00Z' }];
  const taken = (await readOpenTimes(store, { attemptId, busy_read: read(busy) }, clock)).slots;
  assert.ok(!taken.some(slot => slot.startIso === TEN_AM));
  assert.equal(busyOf(read(busy))[0].startMs, Date.parse('2026-11-23T16:00:00Z'));
});

test('a time is chosen only from the open starts; a made-up or taken time is refused and nothing is kept', async () => {
  const { db, store, clock } = await freshDb();
  const attemptId = await toTheSlotStep(store, clock);
  await assert.rejects(chooseSlot(store, { attemptId, value: '2026-11-23T16:07:00.000Z', busy_read: read([]) }, clock), /not open/);
  await assert.rejects(chooseSlot(store, { attemptId, value: TEN_AM, busy_read: read([{ start: TEN_AM, end: '2026-11-23T16:30:00Z' }]) }, clock), /not open/);
  assert.equal((await sittingValue(db, attemptId)).steps.slot, undefined);
  const chosen = await chooseSlot(store, { attemptId, value: TEN_AM, busy_read: read([]) }, clock);
  assert.deepEqual([chosen.next?.key, chosen.slot.startIso, chosen.slot.endIso], ['confirm', TEN_AM, '2026-11-23T16:30:00.000Z']);
  assert.equal((await sittingValue(db, attemptId)).steps.slot, TEN_AM);
});

test('ready answers the event to make, in the zone\'s own clock, and writes nothing; a time taken since is refused', async () => {
  const { db, store, clock } = await freshDb();
  const attemptId = await toTheSlotStep(store, clock);
  await assert.rejects(checkBookingReady(store, { attemptId, busy_read: read([]) }, clock), /not ready/);
  await chooseSlot(store, { attemptId, value: TEN_AM, busy_read: read([]) }, clock);
  const ready = await checkBookingReady(store, { attemptId, busy_read: read([]) }, clock);
  assert.deepEqual(ready.event, { title: 'A call', start_local: '2026-11-23T10:00:00', end_local: '2026-11-23T10:30:00', timezone: 'America/Chicago', attendees: [EMAIL], video_call_request_id: ready.event.video_call_request_id });
  assert.ok(ready.event.video_call_request_id);
  await assert.rejects(checkBookingReady(store, { attemptId, busy_read: read([{ start: TEN_AM, end: '2026-11-23T16:30:00Z' }]) }, clock), /was taken/);
  assert.equal(((await db.query('SELECT count(*)::int n FROM bookings')).rows[0] as { n: number }).n, 0);
});

test('keeping writes the booking row naming its sitting and ends the sitting together, once; the event must be named', async () => {
  const { db, store, clock } = await freshDb();
  const attemptId = await toTheSlotStep(store, clock);
  await chooseSlot(store, { attemptId, value: TEN_AM, busy_read: read([]) }, clock);
  await assert.rejects(keepBooking(store, { attemptId, event: null }, clock), /external_event_id/);
  await assert.rejects(keepBooking(store, { attemptId, event: { external_event_id: 'e1' }, source: ' ' }, clock), /says where it came from/);
  const kept = await keepBooking(store, { attemptId, event: { external_event_id: 'event-1', video_link: 'https://meet.example.test/x' } }, clock);
  assert.deepEqual([kept.meetingLink, kept.startIso], ['https://meet.example.test/x', TEN_AM]);
  const [row] = (await db.query('SELECT * FROM bookings')).rows as Record<string, any>[];
  assert.deepEqual([row.id, row.provider_booking_id, row.booking_type, row.booker_email, row.status, row.came_from, row.form_sitting_id, row.starts_at.toISOString(), row.ends_at.toISOString()],
    [kept.bookingId, 'event-1', SLUG, EMAIL, 'booked', 'booking-page', attemptId, TEN_AM, '2026-11-23T16:30:00.000Z']);
  const sitting = await sittingValue(db, attemptId);
  assert.deepEqual([sitting.status, sitting.bookingId, sitting.lastStep], ['finished', kept.bookingId, 'confirm']);
  await assert.rejects(keepBooking(store, { attemptId, event: { external_event_id: 'event-2' } }, clock), /already made/);
  assert.equal(((await db.query('SELECT count(*)::int n FROM bookings')).rows[0] as { n: number }).n, 1);
});

test('keeping before the time is chosen is refused and writes nothing', async () => {
  const { db, store, clock } = await freshDb();
  const attemptId = await toTheSlotStep(store, clock);
  await assert.rejects(keepBooking(store, { attemptId, event: { external_event_id: 'event-1' } }, clock), /not ready/);
  assert.equal(((await db.query('SELECT count(*)::int n FROM bookings')).rows[0] as { n: number }).n, 0);
  await assert.rejects(readOpenTimes(store, { attemptId: 'nothing', busy_read: read([]) }, clock), /not known/);
});

test('a calendar that was not read is never a free one: unknown, missing or malformed answers are refused by all three steps', async () => {
  const { store, clock } = await freshDb();
  const attemptId = await toTheSlotStep(store, clock);
  for (const unread of [{ status: 'unknown', busy: [] }, { status: 'unknown' }, { busy: [] }, { status: 'read' }, { status: 'read', busy: 'none' }, null, [], 'read']) {
    await assert.rejects(readOpenTimes(store, { attemptId, busy_read: unread }, clock), /could not be read|not understood|Give busy_read/);
    await assert.rejects(chooseSlot(store, { attemptId, value: TEN_AM, busy_read: unread }, clock), /could not be read|not understood|Give busy_read/);
    await assert.rejects(checkBookingReady(store, { attemptId, busy_read: unread }, clock), /could not be read|not understood|Give busy_read|not ready/);
  }
});
