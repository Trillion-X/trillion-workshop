// tools/book-time/do-work/book-time.mjs
//
// The tool seam. Each export is run by tools/records-door/do-work/run-an-export.mjs as fn(input, context), where
// context.door is the person's records door. The calendar exports also read the person's own calendar account from
// descriptor 4: one held value, a JSON object { provider, client_id, client_secret, refresh_token, calendar_id? }.
// That account is never printed, logged or returned, and is scrubbed out of any provider text in an answer.
//
// A booking is one `booking` record in the person's own records. Its statuses are the lifecycle in
// read-data/booking-lifecycle.json, the same { stages, transitions, start } shape tools/move-records-through-declared-states
// reads, so an AI can also ask that tool where a booking may go next.
//
// Every write that takes or frees a time is kept together with the host's `booking-book` record, conditioned on the book
// as it was read (the door's `expected`), so the check and the write are one step: two requests for the last seat
// cannot both land, and two answers to one waiting booking cannot both land. The loser reads again and checks again.
import { fstatSync, readFileSync } from 'node:fs';
import { deriveOpenSlots } from '../read-data/derive-open-slots.ts';
import { calendarInviteFile } from './calendar-invite-file.ts';
import { createExternalCalendarEvent } from './create-external-calendar-event.ts';
import { cancelExternalCalendarEvent, moveExternalCalendarEvent, readExternalCalendarBusy } from './external-calendar-busy-and-changes.ts';
import lifecycle from '../read-data/booking-lifecycle.json' with { type: 'json' };

const BOOKING = 'booking';
const BOOK = 'booking-book';
const MAX_DAYS = 62;
const DAY_MS = 86_400_000;
const BOOK_TRIES = 5;

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

// The rules a booking's time is held by. They are kept on the booking, so a later answer to it is checked by the same rules.
function timeRules(input) {
  const seats = input.seats_per_slot ?? 1;
  needCount(seats, 'seats_per_slot');
  if (input.per_day_max !== undefined && input.per_day_max !== null) needCount(input.per_day_max, 'per_day_max');
  if (input.horizon_days !== undefined && input.horizon_days !== null) needCount(input.horizon_days, 'horizon_days');
  if (input.pending_blocks_slot !== undefined && typeof input.pending_blocks_slot !== 'boolean') throw new Error('pending_blocks_slot must be true or false.');
  return {
    seats_per_slot: seats,
    per_day_max: input.per_day_max ?? null,
    horizon_days: input.horizon_days ?? null,
    pending_blocks_slot: input.pending_blocks_slot ?? true,
    buffer_before_minutes: input.buffer_before_minutes ?? 0,
    buffer_after_minutes: input.buffer_after_minutes ?? 0,
    free_statuses: input.free_statuses ?? ['cancelled'],
  };
}

// The person's own bookings that hold their time: not in a status that frees it, and a booking waiting for the host's
// answer only when the rules say a waiting booking holds its time.
async function heldBookings(door, hostRef, rules, exceptId) {
  const held = [];
  for await (const record of door.list({ type: BOOKING })) {
    const booking = record.value;
    if (!booking || booking.id === exceptId || rules.free_statuses.includes(booking.status)) continue;
    if (!rules.pending_blocks_slot && booking.status === 'pending_confirmation') continue;
    if (hostRef !== undefined && booking.host_ref !== hostRef) continue;
    const startMs = Date.parse(booking.scheduled_start);
    const endMs = Date.parse(booking.scheduled_end);
    if (Number.isFinite(startMs)) held.push({ startMs, endMs: Number.isFinite(endMs) ? endMs : startMs, attendees: booking.attendees ?? [] });
  }
  return held;
}

// The slots that stay open beside the held bookings. A held booking at a slot's exact start fills one of its seats; any
// other held booking blocks every slot its time (widened by the buffers) overlaps. Once `per_day_max` held bookings
// start on a day, the rest of that day closes; nothing is offered past `horizon_days` from now.
function offered(slots, held, rules, timezone, nowMs) {
  const seats = rules.seats_per_slot;
  const before = rules.buffer_before_minutes * 60_000;
  const after = rules.buffer_after_minutes * 60_000;
  const latest = rules.horizon_days ? nowMs + rules.horizon_days * DAY_MS : Infinity;
  const perDay = new Map();
  if (rules.per_day_max) for (const row of held) perDay.set(dateIn(row.startMs, timezone), (perDay.get(dateIn(row.startMs, timezone)) ?? 0) + 1);
  const open = [];
  for (const slot of slots) {
    if (slot.startMs > latest) continue;
    if (rules.per_day_max && (perDay.get(slot.date) ?? 0) >= rules.per_day_max) continue;
    const sharesSeat = row => seats > 1 && row.startMs === slot.startMs && row.endMs === slot.endMs;
    const others = held.filter(row => !sharesSeat(row));
    if (others.some(row => row.startMs === slot.startMs)) continue;
    if (others.some(row => row.endMs > row.startMs && slot.startMs - before < row.endMs && slot.endMs + after > row.startMs)) continue;
    if (seats > 1) {
      const used = held.filter(sharesSeat).length;
      if (used >= seats) continue;
      open.push({ ...slot, seats_left: seats - used });
    } else open.push(slot);
  }
  return open;
}

// Runs `attempt` against the host's book as read and keeps what it answers in one write with the book moved on, the
// book conditioned on how it was read. A write that loses to another reads again and tries again.
async function underTheBook(door, hostRef, attempt) {
  const bookId = `${BOOK}:${hostRef ?? 'default'}`;
  for (let tries = 0; tries < BOOK_TRIES; tries += 1) {
    const book = await door.readRecord(BOOK, bookId);
    const step = await attempt();
    if (!step.records?.length) return step.answer;
    const revision = (book?.value?.revision ?? 0) + 1;
    try {
      await door.write([...step.records, { id: bookId, type: BOOK, value: { revision, updated_at: iso(Date.now()) }, expected: book ?? null }],
        { key: `${step.key}:${revision}` });
      return step.answer;
    } catch (error) {
      if (error?.code !== 'original_command_conflict') throw error;
    }
  }
  throw new Error('The bookings kept changing while this was being kept. Send the same request again.');
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

const shown = slot => ({ start: iso(slot.startMs), end: iso(slot.endMs), date: slot.date, time: slot.time, ...(slot.seats_left ? { seats_left: slot.seats_left } : {}) });
const emailsOf = attendees => new Set((attendees ?? []).map(person => person?.email).filter(email => typeof email === 'string' && email));

export async function findOpenTimes(input, { door }) {
  const first = needText(input.from_date, 'from_date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(first)) throw new Error('from_date must look like 2026-01-31.');
  const days = needCount(input.days ?? 1, 'days');
  if (days > MAX_DAYS) throw new Error(`days may be at most ${MAX_DAYS}.`);
  const rules = timeRules(input);
  const taken = (input.taken ?? []).map((value, index) => instantOf(value, `taken[${index}]`));
  const held = input.use_my_bookings ? await heldBookings(door, input.host_ref, rules) : [];
  const busy = intervalsOf(input.busy, 'busy');
  const nowMs = Date.now();
  const slots = [];
  for (let day = 0; day < days; day += 1) {
    slots.push(...offered(slotsOn(input, addDays(first, day), taken, busy, nowMs), held, rules, input.timezone, nowMs).map(shown));
  }
  return { timezone: input.timezone, count: slots.length, slots };
}

export async function requestABooking(input, { door }) {
  const key = needText(input.idempotency_key, 'idempotency_key');
  const id = `booking:${key}`;
  const startMs = instantOf(input.start, 'start');
  const durationMin = needCount(input.duration_minutes, 'duration_minutes');
  const dateISO = dateIn(startMs, needText(input.timezone, 'timezone'));
  const rules = timeRules(input);
  const status = input.needs_payment ? 'pending_payment' : input.needs_confirmation ? 'pending_confirmation' : 'confirmed';
  if (!mayMove(lifecycle.start, status)) throw new Error(`A booking cannot start at "${status}".`);
  return underTheBook(door, input.host_ref, async () => {
    const existing = await door.read(BOOKING, id);
    if (existing) return { answer: { already_requested: true, booking: existing } };
    const nowMs = Date.now();
    const held = await heldBookings(door, input.host_ref, rules);
    const asking = emailsOf(input.attendees);
    if (rules.seats_per_slot > 1 && held.some(row => row.startMs === startMs && [...emailsOf(row.attendees)].some(email => asking.has(email)))) {
      throw new Error('This person already holds a seat at that time.');
    }
    const open = offered(slotsOn(input, dateISO, [], intervalsOf(input.busy, 'busy'), nowMs), held, rules, input.timezone, nowMs);
    if (!open.some(slot => slot.startMs === startMs)) {
      throw new Error(`That time is not open. Open times on ${dateISO}: ${open.map(slot => slot.time).join(', ') || 'none'}.`);
    }
    const at = iso(nowMs);
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
      time_rules: rules,
      idempotency_key: key,
      created_at: at,
      updated_at: at,
    };
    return { key: `request:${key}`, records: [{ id, type: BOOKING, value: booking, expected: null }], answer: { already_requested: false, booking } };
  });
}

export async function changeABookingStatus(input, { door }) {
  const id = needText(input.booking_id, 'booking_id');
  const to = needText(input.to, 'to');
  const first = await door.read(BOOKING, id);
  if (!first) throw new Error(`There is no booking "${id}".`);
  return underTheBook(door, first.host_ref, async () => {
    const record = await door.readRecord(BOOKING, id);
    const booking = record?.value;
    if (!booking) throw new Error(`There is no booking "${id}".`);
    if (booking.status === to) return { answer: { changed: false, booking } };
    if (!mayMove(booking.status, to)) {
      const options = next(booking.status);
      throw new Error(`A booking that is "${booking.status}" cannot become "${to}". ${options.length ? `It can become: ${options.join(', ')}.` : 'It is finished.'}`);
    }
    const nowMs = Date.now();
    if (booking.status === 'pending_confirmation' && to === 'confirmed') {
      const startMs = Date.parse(booking.scheduled_start);
      if (!(startMs > nowMs)) throw new Error('A request for a time that has passed cannot be confirmed, only cancelled.');
      // A waiting booking that did not hold its time is checked again: the time may have been taken while it waited.
      const rules = { ...timeRules({}), ...booking.time_rules };
      if (!rules.pending_blocks_slot) {
        const slot = { startMs, endMs: Date.parse(booking.scheduled_end), date: dateIn(startMs, booking.timezone), time: '' };
        const held = await heldBookings(door, booking.host_ref, { ...rules, horizon_days: null }, id);
        if (!offered([slot], held, { ...rules, horizon_days: null }, booking.timezone, nowMs).length) throw new Error('That time was taken while the booking waited, so it cannot be confirmed.');
      }
    }
    const at = iso(nowMs);
    const changed = {
      ...booking,
      status: to,
      updated_at: at,
      ...(to === 'cancelled' ? { cancelled_at: at, ...(input.reason ? { cancellation_reason: input.reason } : {}) } : {}),
    };
    return { key: `status:${id}:${to}`, records: [{ id, type: BOOKING, value: changed, expected: record }], answer: { changed: true, booking: changed } };
  });
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
