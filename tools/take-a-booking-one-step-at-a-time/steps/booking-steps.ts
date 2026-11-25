// tools/take-a-booking-one-step-at-a-time/steps/booking-steps.ts
//
// PURPOSE
//   The steps of a booking page, one tool each: start (the email), answer (one question), open times, choose a time, check the
//   booking is ready (the event to make) and keep the made booking. The step rules are this tool's (read-data/booking-steps.mjs);
//   the sitting rows and the one answer are the form tools' (ask-questions-sort-answers-follow-up/steps/sitting.ts); the open times are
//   the Workshop's own derivation (tools/book-time). A booking page is the booking's own settings (booking_pages) and the form it asks
//   first. The calendar is never called here: the person's busy times are an input (the answer of tool:check-when-i-am-busy), and the
//   event is made by tool:put-a-booking-on-my-calendar between `checkBookingReady` and `keepBooking`, so no step holds a calendar key.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A step that needs the person's busy times is given the calendar tool's whole answer (`busy_read`: { status, busy }) and works
//      only when its status is `read`; an answer that says unknown, or none, is refused, so a calendar that was not read is never
//      taken for a free one (an empty busy list of a calendar that was read is a free one).
//   2. A time is booked only if it is one of the open starts worked out now from the page's windows and the busy times given: a
//      time the client made up, or one that was taken, is refused. The check is made again when the booking is made ready.
//   3. `keepBooking` writes the booking row and ends the sitting together, once: a sitting already ended is refused, so the event
//      it names is never kept twice. The caller cancels the event when keeping is refused.
//   4. No page, form, question or word is named here: they are rows.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { stepsOf, nextStepOf, checkAnswer, EMAIL_STEP, SLOT_STEP, CONFIRM_STEP } from '../read-data/booking-steps.mjs';
import { deriveOpenSlots } from '../../book-time/read-data/derive-open-slots.ts';
import { SITTING_KIND, answerQuestion, formOf, progressOf, questionsOf, sittingId, sittingOf, stepView, type Page } from '../../ask-questions-sort-answers-follow-up/steps/sitting.ts';
import type { Store } from '../../ask-questions-sort-answers-follow-up/steps/store.ts';

const DAY_MS = 86400000;
const BOOKING_SOURCE = 'booking-page';
type Clock = { nowMs?: () => number; newId?: () => string };
type Busy = { startMs: number; endMs: number };
type LivePage = Page & { slug: string; title: string; duration_minutes: number; timezone: string; windows: unknown[]; horizon_days: number; min_notice_minutes: number };

// The live page with its form's questions in the form's order. A page that is not live, has no windows yet, or names no kept form
// offers nothing.
export async function loadLivePage(store: Store, slug: string): Promise<LivePage> {
  const page = await store.bookingPage(slug);
  if (!page) throw new Error('This booking page is not open.');
  if (!Array.isArray(page.windows) || page.windows.length === 0) throw new Error('This booking page has no times to offer yet.');
  const form = await formOf(store, page.form_id ?? '');
  if (!form) throw new Error('This booking page has no questions yet.');
  return { ...page, formId: form.formId, questions: questionsOf(form) } as LivePage;
}

// The person's busy times from the whole answer of tool:check-when-i-am-busy ({ status, busy: [{ start, end }] }, instants as text).
// An answer whose status is not `read`, a busy that is not a list, or a block that is not a pair of instants is refused: the calendar
// was not read.
export function busyOf(given: unknown): Busy[] {
  const answer = given as { status?: unknown; busy?: unknown } | null;
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('Give busy_read: the whole answer of the calendar read.');
  if (answer.status !== 'read') throw new Error('The calendar could not be read right now. Try again.');
  if (!Array.isArray(answer.busy)) throw new Error('The calendar answer was not understood.');
  return answer.busy.map(block => {
    const startMs = Date.parse(String((block as { start?: unknown })?.start));
    const endMs = Date.parse(String((block as { end?: unknown })?.end));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) throw new Error('The calendar answer was not understood.');
    return { startMs, endMs };
  });
}

// Email first: the sitting is opened with the booker's address, and its first step is the first question (or the slot).
export async function startBooking(store: Store, { slug, email }: { slug: string; email: unknown }, { newId = () => crypto.randomUUID(), nowMs = () => Date.now() }: Clock = {}) {
  const page = await loadLivePage(store, slug);
  const checked = checkAnswer(stepsOf(page)[0], email);
  if (!checked.ok) throw new Error(checked.reason);
  const id = newId();
  const sitting = { kind: SITTING_KIND, formId: page.formId, respondentId: checked.value, submissionId: id, page: slug, status: 'started', lastStep: EMAIL_STEP, startedAt: new Date(nowMs()).toISOString(), steps: {} };
  await store.apply([{ kind: 'insert', id: sittingId(id), type: SITTING_KIND, value: sitting }]);
  const fresh = { email: checked.value, answers: {}, slot: null };
  return { attemptId: id, next: stepView(page, nextStepOf(page, fresh), fresh) };
}

// One question, kept as its own answer; the same question answered again replaces its answer.
export async function answerBookingQuestion(store: Store, { attemptId, value }: { attemptId: string; value: unknown }, { nowMs = () => Date.now() }: Clock = {}) {
  return answerQuestion(store, { attemptId, value, now: () => new Date(nowMs()).toISOString() }, { pageOf: sitting => loadLivePage(store, sitting.page) });
}

const localDateISO = (timezone: string, ms: number) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

// Local wall-clock text in the zone, as the calendar tool reads a time with its timezone name.
const localText = (iso: string, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
};

// The open starts of the page: each day of the horizon, the windows minus the busy time given.
export function openSlots(page: LivePage, { busy, nowMs }: { busy: Busy[]; nowMs: number }) {
  const slots: { startMs: number; endMs: number }[] = [];
  for (let day = 0; day < page.horizon_days; day += 1) {
    slots.push(...deriveOpenSlots({
      timezone: page.timezone, windows: page.windows as never, dateISO: localDateISO(page.timezone, nowMs + day * DAY_MS), durationMin: page.duration_minutes,
      stepMin: page.duration_minutes, minNoticeMin: page.min_notice_minutes, nowMs, busy,
    }));
  }
  return slots;
}

async function pageOfStarted(store: Store, attemptId: string) {
  const sitting = await sittingOf(store, attemptId);
  return { sitting, page: await loadLivePage(store, sitting.page) };
}

// The open times for a sitting, from the busy times given.
export async function readOpenTimes(store: Store, { attemptId, busy_read }: { attemptId: string; busy_read: unknown }, { nowMs = () => Date.now() }: Clock = {}) {
  const { page } = await pageOfStarted(store, attemptId);
  const slots = openSlots(page, { busy: busyOf(busy_read), nowMs: nowMs() });
  return { slots: slots.map(slot => ({ startIso: new Date(slot.startMs).toISOString(), endIso: new Date(slot.endMs).toISOString() })) };
}

// The slot step: the start must be one of the open starts worked out now, so a time the client made up or one that was taken is refused.
export async function chooseSlot(store: Store, { attemptId, value, busy_read }: { attemptId: string; value: unknown; busy_read: unknown }, { nowMs = () => Date.now() }: Clock = {}) {
  const { sitting, page } = await pageOfStarted(store, attemptId);
  const progress = await progressOf(store, page, sitting);
  if (nextStepOf(page, progress)?.key !== SLOT_STEP) throw new Error('The booking is not waiting for a time.');
  const checked = checkAnswer({ kind: 'slot' }, value);
  if (!checked.ok) throw new Error(checked.reason);
  const slot = openSlots(page, { busy: busyOf(busy_read), nowMs: nowMs() }).find(open => new Date(open.startMs).toISOString() === checked.value);
  if (!slot) throw new Error('That time is not open.');
  await store.apply([{ kind: 'merge', id: sittingId(sitting.submissionId), changes: { lastStep: SLOT_STEP, steps: { ...sitting.steps, slot: checked.value } } }]);
  const later = { ...progress, slot: checked.value };
  return { next: stepView(page, nextStepOf(page, later), later), slot: { startIso: checked.value, endIso: new Date(slot.endMs).toISOString() } };
}

// The confirm step, first half: the sitting is at its confirm step and the chosen time is still open, so the event can be made. Answers
// the input of tool:put-a-booking-on-my-calendar; nothing is written and nothing is made.
export async function checkBookingReady(store: Store, { attemptId, busy_read }: { attemptId: string; busy_read: unknown }, { nowMs = () => Date.now(), newId = () => crypto.randomUUID() }: Clock = {}) {
  const { sitting, page } = await pageOfStarted(store, attemptId);
  const progress = await progressOf(store, page, sitting);
  if (nextStepOf(page, progress)?.key !== CONFIRM_STEP) throw new Error('The booking is not ready to confirm.');
  const startMs = Date.parse(progress.slot as string);
  const endMs = startMs + page.duration_minutes * 60000;
  if (!openSlots(page, { busy: busyOf(busy_read), nowMs: nowMs() }).some(open => open.startMs === startMs)) throw new Error('That time was taken. Choose another time.');
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  return {
    startIso, endIso,
    event: { title: page.title, start_local: localText(startIso, page.timezone), end_local: localText(endIso, page.timezone), timezone: page.timezone, attendees: [progress.email], video_call_request_id: newId() },
  };
}

// The confirm step, second half: the event was made; the booking row, naming its sitting, and the sitting's end are written together.
// A sitting already ended is refused, so one event is kept once.
export async function keepBooking(
  store: Store,
  { attemptId, event, source = BOOKING_SOURCE }: { attemptId: string; event: { external_event_id?: unknown; video_link?: unknown } | null; source?: unknown },
  { newId = () => crypto.randomUUID(), nowMs = () => Date.now() }: Clock = {},
) {
  if (typeof source !== 'string' || source.trim() === '') throw new Error('A booking says where it came from.');
  const eventId = event?.external_event_id;
  if (typeof eventId !== 'string' || eventId === '') throw new Error('Give event: the answer of the tool that made the event, with its external_event_id.');
  const meetingLink = typeof event?.video_link === 'string' && event.video_link !== '' ? event.video_link : null;
  const { sitting, page } = await pageOfStarted(store, attemptId);
  const progress = await progressOf(store, page, sitting);
  if (nextStepOf(page, progress)?.key !== CONFIRM_STEP) throw new Error('The booking is not ready to confirm.');
  const endIso = new Date(Date.parse(progress.slot as string) + page.duration_minutes * 60000).toISOString();
  const bookingId = newId();
  await store.apply([
    {
      kind: 'sql',
      sql: `INSERT INTO bookings (id, provider, provider_booking_id, booking_type, starts_at, ends_at, booker_email, booker_timezone, status, meeting_link, calendar_event_ref, came_from, made_at, form_sitting_id)
       VALUES ($1, 'google', $2, $3, $4, $5, $6, $7, 'booked', $8, $2, $9, $10, $11)`,
      params: [bookingId, eventId, page.slug, progress.slot, endIso, progress.email, page.timezone, meetingLink, source, new Date(nowMs()).toISOString(), sitting.submissionId],
    },
    { kind: 'merge', id: sittingId(sitting.submissionId), changes: { status: 'finished', lastStep: CONFIRM_STEP, bookingId } },
  ]);
  return { bookingId, meetingLink, startIso: progress.slot };
}
