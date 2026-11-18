// A host's own calendar service, when the host has connected one: open times, booking, moving and cancelling go
// through the Workshop tool rows derived from that service's service-connections DATA, run in the HOST's own Trillion
// account with the connection the host made there. Nothing here names a service; the bookable row says which tools,
// and where each reply keeps what this reads (`host.calendar_service`):
//
//   account     { setting }  the Worker setting that holds the host's Trillion account id
//   tools       { event_types, open_times, book, move, cancel, read }: shared tool row ids
//   event_type  { when, missing }: the condition (src/booking.mjs `holds`) the host's one event type for this session
//               meets, exactly one must; `missing` is what the person is told when the service has none
//   reply       { event_types, times, booking }: each a path of keys to the list or object in that tool's reply
//               fields: { event_type_id, start, end, booking_ref, state, moved_to, video_link }: the field names
//               inside them (`video_link` lists the fields that may hold the call's join address; the first wins)
//               cancelled_states: the states that mean a booking no longer holds its time
//
// Every tool takes the same inputs, so a second service is a second set of rows answering these names:
//   event_types {}                                open_times { event_type_id, start, end, time_zone }
//   book { event_type_id, start, name, email, time_zone, notes? }   (notes: short text fields kept on the booking)
//   move { booking_uid, start }   cancel { booking_uid }   read { booking_uid }
//
// `run(tool_id, input)` is the host's Workshop (hostToolRunner(env)(spec.account)): { connected: false } when the host has not connected
// the service those tools use, else the task ({ state, output, error }). A host with no connection, or with no single
// event type meeting the row's condition, books by the row's own rules (src/booking.mjs openTimes), and the person is
// told why in the row's own words.
import { BookingRefusal, holds } from './booking.mjs';
import { hostOf } from './resource-host.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const at = (value, path) => (path ?? []).reduce((here, key) => (here === null || here === undefined ? undefined : here[key]), value);
const iso = ms => new Date(ms).toISOString();
const address = value => (typeof value === 'string' && /^https:\/\/\S+$/.test(value) ? value : null);
const EVENT_TYPE_SECONDS = 600;

/** The host's calendar service for a bookable row, or null when the row names none. */
export function calendarService(row, run, { now = () => Date.now() } = {}) {
  const spec = row.host?.calendar_service;
  if (!object(spec)) return null;
  const fields = spec.reply.fields;
  let chosen = null;

  async function call(verb, input) {
    const task = await run(spec.tools[verb], input);
    if (task.connected === false) return { connected: false };
    if (task.state !== 'completed') return { connected: true, error: task.error ?? `the ${verb} call ${task.state ?? 'did not finish'}` };
    return { connected: true, output: task.output };
  }
  const bookingOf = output => {
    const found = at(output, spec.reply.booking);
    if (!object(found) || typeof found[fields.booking_ref] !== 'string') throw new BookingRefusal(502, `${row.host.name}'s calendar answered without the booking. Try again.`);
    return {
      ref: found[fields.booking_ref], start_ms: Date.parse(found[fields.start]), end_ms: Date.parse(found[fields.end]),
      cancelled: (spec.reply.cancelled_states ?? []).includes(found[fields.state]), moved_to: found[fields.moved_to] ?? null,
      video_link: [].concat(fields.video_link ?? []).map(field => address(found[field])).find(Boolean) ?? null,
    };
  };
  const refused = what => new BookingRefusal(409, `${what} Pick another time, or reply to your booking email to reach ${row.host.name}.`);

  return {
    /** { ready: true, event_type_id } when the host's connected service has exactly one event type meeting the row's
     * condition; else { ready: false, reason, say? } (`say`: words for the person when the service is connected but
     * cannot take this session). Read at most every ten minutes. */
    async ready() {
      if (chosen && now() - chosen.at < EVENT_TYPE_SECONDS * 1000) return chosen.state;
      const listed = await call('event_types', {});
      const state = (() => {
        if (!listed.connected) return { ready: false, reason: 'not connected' };
        if (listed.error) return { ready: false, reason: `its event types could not be read: ${listed.error}` };
        const matches = (at(listed.output, spec.reply.event_types) ?? []).filter(item => object(item) && holds(spec.event_type?.when, item));
        if (matches.length === 1) return { ready: true, event_type_id: matches[0][fields.event_type_id] };
        return matches.length
          ? { ready: false, reason: `${matches.length} event types fit`, say: `${row.host.name}'s calendar has ${matches.length} event types that fit this session, so none is picked for it.` }
          : { ready: false, reason: 'no event type fits', say: spec.event_type?.missing ?? `${row.host.name}'s calendar has no event type for this session yet.` };
      })();
      chosen = { at: now(), state };
      return state;
    },
    /** Open times between two moments, as { start_ms, end_ms }, soonest first. */
    async times(eventTypeId, fromMs, toMs) {
      const read = await call('open_times', { event_type_id: eventTypeId, start: iso(fromMs), end: iso(toMs), time_zone: row.rules.timezone });
      if (!read.connected || read.error) throw new BookingRefusal(502, `${row.host.name}'s open times could not be read right now. Try again shortly.`);
      const found = [];
      const walk = value => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (object(value)) { if (typeof value[fields.start] === 'string') found.push(value); else Object.values(value).forEach(walk); }
      };
      walk(at(read.output, spec.reply.times));
      return found.map(item => {
        const start = Date.parse(item[fields.start]);
        return { start_ms: start, end_ms: typeof item[fields.end] === 'string' ? Date.parse(item[fields.end]) : start + row.rules.session_minutes * 60000 };
      }).filter(time => Number.isFinite(time.start_ms)).sort((a, b) => a.start_ms - b.start_ms);
    },
    async book(eventTypeId, { start_ms: startMs, name, email, time_zone: timeZone, notes = null }) {
      const made = await call('book', { event_type_id: eventTypeId, start: iso(startMs), name, email, time_zone: timeZone, ...(notes ? { notes } : {}) });
      if (!made.connected || made.error) throw refused('That time could not be booked.');
      return bookingOf(made.output);
    },
    async move(ref, startMs) {
      const moved = await call('move', { booking_uid: ref, start: iso(startMs) });
      if (!moved.connected || moved.error) throw refused('The session could not be moved to that time.');
      return bookingOf(moved.output);
    },
    async cancel(ref) {
      const cancelled = await call('cancel', { booking_uid: ref });
      if (!cancelled.connected || cancelled.error) throw new BookingRefusal(502, `The session could not be cancelled on ${row.host.name}'s calendar right now. Try again shortly.`);
      return bookingOf(cancelled.output);
    },
    /** The booking as the host's calendar holds it now, or null when it cannot be read. */
    async read(ref) {
      const read = await call('read', { booking_uid: ref });
      if (!read.connected || read.error) return null;
      try { return bookingOf(read.output); } catch { return null; }
    },
  };
}

/** Runs a shared tool in the host's own Trillion account (the account a row's `account.setting` names, for its calendar
 * or its calendar service), through that account's Workshop exactly as the host's AI would. */
export const hostToolRunner = env => spec => async (toolId, input) => {
  const account = spec?.setting ? env?.[spec.setting] : null;
  if (typeof account !== 'string' || !account) return { connected: false };
  const store = hostOf(env, { kind: 'person', key: account });
  const response = await store.fetch(new Request('https://person/tools/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool_id: toolId, input, request_key: `booking:${crypto.randomUUID()}`, wait_seconds: 50 }),
  }));
  const result = await response.json().catch(() => ({}));
  if (response.ok) return result;
  return result.missing_connection ? { connected: false } : { state: 'failed', error: result.error ?? `answered ${response.status}` };
};
