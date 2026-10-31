// tools/book-time/do-work/book-time.mjs
//
// The tool seam. Each export is run by tools/records-door/do-work/run-an-export.mjs as fn(input, context), where
// context.door is the person's records door. The calendar exports also read the person's own calendar account from
// descriptor 4: one held value, a JSON object { provider, client_id, client_secret, refresh_token, calendar_id? }.
// That account is never printed, logged or returned, and is scrubbed out of any provider text in an answer.
//
// A booking is one `booking` record in the person's own records. Its statuses are the lifecycle in
// read-data/booking-lifecycle.json, the same { stages, transitions, start } shape tools/move-records-through-declared-states
// reads, so an AI can also ask that tool where a booking may go next. The records door has no compare-and-swap, so two
// requests for one time that arrive in the same instant can both pass the open-time check.
import { fstatSync, readFileSync } from 'node:fs';
import { deriveOpenSlots } from '../read-data/derive-open-slots.ts';
import { calendarInviteFile } from './calendar-invite-file.ts';
import { createExternalCalendarEvent } from './create-external-calendar-event.ts';
import { cancelExternalCalendarEvent, moveExternalCalendarEvent, readExternalCalendarBusy } from './external-calendar-busy-and-changes.ts';
import lifecycle from '../read-data/booking-lifecycle.json' with { type: 'json' };

const BOOKING = 'booking';
const MAX_DAYS = 62;
const DAY_MS = 86_400_000;

const needText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value;
};
const needCount = (value, field, least = 1) => {
  if (!Number.isInteger(value) || value < least) throw new Error(`${field} must be a whole number, ${least} or more.`);
  return value;
};
// An instant: an ISO string with a zone offset, or milliseconds.
const instantOf = (value, field) => {
  const ms = typeof value === 'number' ? value : Date.parse(needText(value, field));
  if (!Number.isFinite(ms)) throw new Error(`${field} must be an instant like 2026-01-02T09:00:00-07:00.`);
  return ms;
};
const iso = ms => new Date(ms).toISOString();
const dateIn = (ms, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (dateISO, days) => iso(Date.parse(`${dateISO}T00:00:00Z`) + days * DAY_MS).slice(0, 10);
const intervalsOf = (list, field) => (list ?? []).map((block, index) => ({
  startMs: instantOf(block.start, `${field}[${index}].start`),
  endMs: instantOf(block.end, `${field}[${index}].end`),
}));

const next = stage => lifecycle.transitions.filter(move => move.from === stage).map(move => move.to);
const mayMove = (from, to) => lifecycle.transitions.some(move => move.from === from && move.to === to);

// Starts already booked, from the person's own booking records (a cancelled booking frees its time).
async function bookedStarts(door, hostRef, freeStatuses) {
  const starts = [];
  for await (const record of door.list({ type: BOOKING })) {
    const booking = record.value;
    if (!booking || freeStatuses.includes(booking.status)) continue;
    if (hostRef !== undefined && booking.host_ref !== hostRef) continue;
    starts.push(Date.parse(booking.scheduled_start));
  }
  return starts.filter(Number.isFinite);
}

function slotsOn(input, dateISO, taken, busy, nowMs) {
  return deriveOpenSlots({
    timezone: needText(input.timezone, 'timezone'),
    windows: input.windows ?? [],
    dateISO,
    durationMin: needCount(input.duration_minutes, 'duration_minutes'),
    stepMin: needCount(input.step_minutes ?? input.duration_minutes, 'step_minutes'),
    bufferBeforeMin: needCount(input.buffer_before_minutes ?? 0, 'buffer_before_minutes', 0),
    bufferAfterMin: needCount(input.buffer_after_minutes ?? 0, 'buffer_after_minutes', 0),
    minNoticeMin: needCount(input.min_notice_minutes ?? 0, 'min_notice_minutes', 0),
    ...(input.min_notice_minutes ? { nowMs } : {}),
    taken,
    busy,
  });
}

const shown = slot => ({ start: iso(slot.startMs), end: iso(slot.endMs), date: slot.date, time: slot.time });

export async function findOpenTimes(input, { door }) {
  const first = needText(input.from_date, 'from_date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(first)) throw new Error('from_date must look like 2026-01-31.');
  const days = needCount(input.days ?? 1, 'days');
  if (days > MAX_DAYS) throw new Error(`days may be at most ${MAX_DAYS}.`);
  const freeStatuses = input.free_statuses ?? ['cancelled'];
  const taken = [...(input.taken ?? []).map((value, index) => instantOf(value, `taken[${index}]`)),
    ...(input.use_my_bookings ? await bookedStarts(door, input.host_ref, freeStatuses) : [])];
  const busy = intervalsOf(input.busy, 'busy');
  const nowMs = Date.now();
  const slots = [];
  for (let day = 0; day < days; day += 1) slots.push(...slotsOn(input, addDays(first, day), taken, busy, nowMs).map(shown));
  return { timezone: input.timezone, count: slots.length, slots };
}

export async function requestABooking(input, { door }) {
  const key = needText(input.idempotency_key, 'idempotency_key');
  const id = `booking:${key}`;
  const existing = await door.read(BOOKING, id);
  if (existing) return { already_requested: true, booking: existing };
  const startMs = instantOf(input.start, 'start');
  const durationMin = needCount(input.duration_minutes, 'duration_minutes');
  const dateISO = dateIn(startMs, needText(input.timezone, 'timezone'));
  const taken = await bookedStarts(door, input.host_ref, input.free_statuses ?? ['cancelled']);
  const open = slotsOn(input, dateISO, taken, intervalsOf(input.busy, 'busy'), Date.now());
  if (!open.some(slot => slot.startMs === startMs)) {
    throw new Error(`That time is not open. Open times on ${dateISO}: ${open.map(slot => slot.time).join(', ') || 'none'}.`);
  }
  const status = input.needs_payment ? 'pending_payment' : input.needs_confirmation ? 'pending_confirmation' : 'confirmed';
  if (!mayMove(lifecycle.start, status)) throw new Error(`A booking cannot start at "${status}".`);
  const at = iso(Date.now());
  const booking = {
    id,
    ...(input.host_ref ? { host_ref: input.host_ref } : {}),
    ...(input.booking_type ? { booking_type: input.booking_type } : {}),
    ...(input.title ? { title: input.title } : {}),
    status,
    scheduled_start: iso(startMs),
    scheduled_end: iso(startMs + durationMin * 60_000),
    timezone: input.timezone,
    attendees: input.attendees ?? [],
    idempotency_key: key,
    created_at: at,
    updated_at: at,
  };
  await door.write([{ id, type: BOOKING, value: booking }], { key: `request:${key}` });
  if ((await door.read(BOOKING, id))?.idempotency_key !== key) throw new Error('The booking was not kept. Send the same request again with the same idempotency_key.');
  return { already_requested: false, booking };
}

export async function changeABookingStatus(input, { door }) {
  const id = needText(input.booking_id, 'booking_id');
  const to = needText(input.to, 'to');
  const booking = await door.read(BOOKING, id);
  if (!booking) throw new Error(`There is no booking "${id}".`);
  if (booking.status === to) return { changed: false, booking };
  if (!mayMove(booking.status, to)) {
    const options = next(booking.status);
    throw new Error(`A booking that is "${booking.status}" cannot become "${to}". ${options.length ? `It can become: ${options.join(', ')}.` : 'It is finished.'}`);
  }
  const at = iso(Date.now());
  const changed = {
    ...booking,
    status: to,
    updated_at: at,
    ...(to === 'cancelled' ? { cancelled_at: at, ...(input.reason ? { cancellation_reason: input.reason } : {}) } : {}),
  };
  await door.write([{ id, type: BOOKING, value: changed }], { key: `status:${id}:${to}` });
  return { changed: true, booking: changed };
}

// The person's own calendar account, from the private pipe the run was handed (or injected by a test).
function accountOf(context) {
  if (context.credential) return context.credential;
  let text;
  const fd = context.credentialFd ?? 4;
  try {
    // The account arrives on the private pipe the row's credential mount opens; a run without that mount has no account.
    const kind = fstatSync(fd);
    if (!kind.isFIFO() && !kind.isFile()) throw new Error('not an account');
    text = readFileSync(fd, 'utf8');
  } catch { throw new Error('This run was handed no calendar account. Keep your calendar account as a held value and let this tool use it.'); }
  const account = JSON.parse(text);
  if (!account || typeof account.provider !== 'string') throw new Error('The calendar account must be a JSON object with a provider.');
  return account;
}
// Provider text can echo a request; never let the account's secret parts leave in an answer.
const scrub = (text, account) => [account.client_secret, account.refresh_token, account.client_id]
  .filter(part => typeof part === 'string' && part.length > 0)
  .reduce((out, part) => out.split(part).join('[hidden]'), text ?? '');

export async function checkWhenIAmBusy(input, context) {
  const account = accountOf(context);
  const answer = await readExternalCalendarBusy(account, instantOf(input.from, 'from'), instantOf(input.to, 'to'), context.fetch);
  return {
    status: answer.status,
    busy: answer.busy.map(block => ({ start: iso(block.startMs), end: iso(block.endMs) })),
    ...(answer.error ? { error: scrub(answer.error, account) } : {}),
  };
}

export async function putABookingOnMyCalendar(input, context) {
  const account = accountOf(context);
  const answer = await createExternalCalendarEvent(account, {
    title: needText(input.title, 'title'),
    start_local: needText(input.start_local, 'start_local'),
    end_local: needText(input.end_local, 'end_local'),
    timezone: needText(input.timezone, 'timezone'),
    attendees: input.attendees ?? [],
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.reminder_minutes ? { reminder_minutes: input.reminder_minutes } : {}),
    ...(input.video_call_request_id ? { video_call: { request_id: input.video_call_request_id } } : {}),
  }, context.fetch);
  const result = { ...answer, ...(answer.error ? { error: scrub(answer.error, account) } : {}) };
  if (input.booking_id && result.status === 'created') {
    const booking = await context.door.read(BOOKING, input.booking_id);
    if (!booking) throw new Error(`The event was made (${result.external_event_id}), but there is no booking "${input.booking_id}" to note it on.`);
    await context.door.write([{ id: booking.id, type: BOOKING, value: {
      ...booking,
      external_calendar_event_id: result.external_event_id,
      ...(result.video_link ? { meeting_url: result.video_link } : {}),
      updated_at: iso(Date.now()),
    } }], { key: `calendar-event:${booking.id}:${result.external_event_id}` });
  }
  return result;
}

export async function moveABookingOnMyCalendar(input, context) {
  const account = accountOf(context);
  const answer = await moveExternalCalendarEvent(account, needText(input.event_id, 'event_id'), iso(instantOf(input.start, 'start')), iso(instantOf(input.end, 'end')), context.fetch);
  return { ...answer, ...(answer.error ? { error: scrub(answer.error, account) } : {}) };
}

export async function cancelABookingOnMyCalendar(input, context) {
  const account = accountOf(context);
  const answer = await cancelExternalCalendarEvent(account, needText(input.event_id, 'event_id'), context.fetch);
  return { ...answer, ...(answer.error ? { error: scrub(answer.error, account) } : {}) };
}

export function makeACalendarInvite(input) {
  const uid = needText(input.uid, 'uid');
  needText(input.organizer?.email, 'organizer.email');
  const text = calendarInviteFile({
    uid,
    start_ms: instantOf(input.start, 'start'),
    end_ms: instantOf(input.end, 'end'),
    summary: needText(input.summary, 'summary'),
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
    organizer: input.organizer,
    attendees: input.attendees ?? [],
    method: input.method === 'CANCEL' ? 'CANCEL' : 'REQUEST',
    sequence: needCount(input.sequence ?? 0, 'sequence', 0),
    now_ms: Date.now(),
    ...(input.reminder_minutes ? { reminder_minutes: input.reminder_minutes } : {}),
  });
  return { filename: `${uid.replace(/[^A-Za-z0-9._-]+/g, '-')}.ics`, text };
}
