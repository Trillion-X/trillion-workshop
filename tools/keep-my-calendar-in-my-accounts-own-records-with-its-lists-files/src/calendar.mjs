// src/calendar.mjs
//
// Purpose
//   The one calendar reader for every screen; a screen that reads dated things for itself repeats it. It is the one
//   Calendar: every dated thing a person can see between two times, read from every source src/calendar.json
//   names (the meetings of every space they are in, their posts, the events on their own connected calendar) into one
//   list of items. There is no calendar inside a space: a space's meetings are its Network records, read here like any
//   other source, and the person's Focus narrows this list to a space or a pursuit the same way it narrows every other
//   list (src/record-scope.json lists, src/work-scope.mjs).
//
//   GET /calendar?from=&to=   { from, to, items: [item], sources: [{ id, label, read, connected?, said? }] }
//     item: { id, source, source_id, source_record_id, source_url, title, about, starts_at, ends_at, all_day, location, conference_url, attendees, space_id, space_title, ref, going,
//             may_move, status, link }   (how a source's items look and what they offer is its row, read by the screen)
//
// Non-Negotiable Invariants
//   1. Nothing here names a source, a service or a field: each source is a row of src/calendar.json, read by `route`
//      (the person's own store, the road their AI takes) or by `tool` (one of their own Workshop tools, so a connected
//      calendar is read through their own connection and its values never leave their locked box).
//   2. A source that cannot be read is said in words and never stops the others; a calendar that is not connected is
//      said as such, never shown as empty.
//   3. A meeting put on a member's own calendar (src/space-calendars.mjs) is shown once: its copy there is dropped by
//      the source's `copies_of` row.
//   4. Read only. Moving, answering and putting on meetings keep their own roads (/community/...).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import settings from './calendar.json' with { type: 'json' };
import { MEETING_ATTENDEES_MOST } from '../../record-voice-and-meetings/do-work/meeting-join-recording.ts';
import { readCalendarEventColors, withCalendarEventColors } from '../../connect-a-service-and-seal-its-key/read-data/calendar-connection-options.ts';

const DAY_MS = 86_400_000;
const pick = (value, path) => path.reduce((at, key) => (at && typeof at === 'object' ? at[key] : undefined), value);
const first = (row, paths) => { for (const path of paths ?? []) { const value = pick(row, path); if (value !== undefined && value !== null && value !== '') return value; } return null; };
const fill = (value, values) => (typeof value === 'string' ? value.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''))
  : Array.isArray(value) ? value.map(item => fill(item, values))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, values)])) : value);
const say = (key, values = {}) => fill(settings.words[key], values);
const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const instant = value => (dateOnly(value) ? `${value}T00:00:00.000Z` : new Date(Date.parse(value)).toISOString());

export class CalendarError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

/** The span asked for, checked: from before to, at most `span_most_days` apart. */
export function spanOf({ from, to }) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > settings.span_most_days * DAY_MS) throw new CalendarError(say('bad_span', { days: settings.span_most_days }));
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

/** The people a provider row invites, as { name?, email? }, at most MEETING_ATTENDEES_MOST (null when the source names none). */
function attendeesOf(row, source) {
  const list = first(row, source.fields.attendees);
  if (!Array.isArray(list)) return null;
  const people = [];
  for (const entry of list) {
    if (people.length >= MEETING_ATTENDEES_MOST) break;
    const name = first(entry, source.fields.attendee_name), email = first(entry, source.fields.attendee_email);
    if (typeof name === 'string' || typeof email === 'string') people.push({ ...(typeof name === 'string' ? { name } : {}), ...(typeof email === 'string' ? { email } : {}) });
  }
  return people;
}

/** One source row's answer as calendar items (pure). */
export function itemsOf(source, answer) {
  const rows = pick(answer, source.rows);
  if (!Array.isArray(rows)) return [];
  const items = [];
  for (const row of rows) {
    const inactive = Boolean(source.skip_when && Object.entries(source.skip_when).every(([field, value]) => first(row, source.fields[field]) === value));
    if (inactive && (!source.keep_when_fields_present?.length || !source.keep_when_fields_present.every(field => first(row, source.fields[field]) !== null))) continue;
    const id = first(row, source.fields.id);
    const starts = first(row, source.fields.starts_at);
    if (id === null || starts === null || !Number.isFinite(Date.parse(starts))) continue;
    const ends = first(row, source.fields.ends_at);
    const title = String(first(row, source.fields.title) ?? source.default_title ?? '').split('\n').find(line => line.trim())?.trim().slice(0, 200) ?? '';
    const ref = source.ref ? pick(row, source.ref.path) : null;
    const attendees = attendeesOf(row, source);
    items.push({
      id: `${source.id}:${id}`, source: source.id, source_id: String(id), title,
      about: first(row, source.fields.about), starts_at: instant(starts), ends_at: ends !== null && Number.isFinite(Date.parse(ends)) ? instant(ends) : null,
      all_day: dateOnly(starts), space_id: first(row, source.fields.space_id), space_title: first(row, source.fields.space_title),
      ...(dateOnly(starts) ? { day: starts, ...(dateOnly(ends) ? { day_end: ends } : {}) } : {}),
      source_record_id: first(row, source.fields.source_record_id), source_url: first(row, source.fields.source_url),
      location: first(row, source.fields.location), conference_url: first(row, source.fields.conference_url),
      recurring_event_id: first(row, source.fields.recurring_event_id),
      ...(attendees?.length ? { attendees } : {}),
      ...Object.fromEntries(['color_id', 'visibility', 'transparency'].flatMap(field => {
        const value = first(row, source.fields[field]);
        return value === null ? [] : [[field, value]];
      })),
      ref: ref === undefined || ref === null ? null : `${source.ref.prefix ?? ''}${ref}`,
      going: first(row, source.fields.going),
      // A provider can say an item is writable in more than one way (Google
      // marks the organizer or creator as self). Missing evidence stays false.
      may_move: !inactive && (source.writable === true || (source.fields.may_move ?? []).some(path => pick(row, path) === true)),
      may_cancel: !inactive && (source.writable === true || (source.fields.may_cancel ?? []).some(path => pick(row, path) === true)),
      status: first(row, source.fields.status),
      link: first(row, source.fields.link),
    });
  }
  return items;
}

/**
 * Every item between from and to. `io`:
 *   route(path)            GET from the person's own store, answering its JSON (throws on a refusal)
 *   runTool(id, input, key) one of the person's Workshop tools: the task, or { connected: false } when the
 *                          connection it uses is not connected here
 *   readRecord(id)         one of the person's records, or null (a placed meeting's copy, src/space-calendars.mjs)
 *   now()                  the time
 */
export async function readCalendar(asked, { route, runTool, readRecord, sources = settings.sources, revisionOf = () => '', now = () => Date.now() }) {
  const span = spanOf(asked ?? {});
  const query = `from=${encodeURIComponent(span.from)}&to=${encodeURIComponent(span.to)}`;
  // A connected calendar's answer is used again for `reuse_minutes`, named by the span and that stretch of time.
  const stretch = asked?.fresh === true ? crypto.randomUUID() : Math.floor(now() / (settings.reuse_minutes * 60_000));
  const read = await Promise.all(sources.map(async source => {
    const label = source.look?.label ?? source.id;
    try {
      if (source.unavailable === true) return {
        source, items: [], read: false, complete: false,
        said: say('unread', { source: label }),
      };
      if (source.route) {
        const answer = await route(`${source.route}?${query}`);
        return {
          source, items: itemsOf(source, answer), read: true,
          ...(answer?.page && typeof answer.page.complete === 'boolean' ? { complete: answer.page.complete, next_cursor: answer.page.next_cursor ?? null } : {}),
        };
      }
      if (!source.selection && source.calendar_connection?.event_color_catalog) {
        const metadata = await readCalendarEventColors({ runTool }, source.calendar_connection, undefined, `calendar-colors:${source.id}:${stretch}`);
        source = withCalendarEventColors(source, metadata);
      }
      const revision = revisionOf(source.base_source ?? source.id);
      const key = `calendar:${source.id}:${span.from}:${span.to}:${stretch}${revision ? `:${revision}` : ''}`;
      const items = [];
      let cursor = null;
      const seen = new Set();
      for (let page = 0; page < (source.pagination?.max_pages ?? 1); page += 1) {
        const task = await runTool(source.tool, {
          ...fill(source.input ?? {}, span),
          ...(cursor && source.pagination?.input_field ? { [source.pagination.input_field]: cursor } : {}),
        }, `${key}${cursor ? `:page:${cursor}` : ''}`);
        if (task?.connected === false) return { source, items: [], read: false, complete: false, connected: false, said: say('not_connected', { source: label }) };
        if (task?.state !== 'completed') return { source, items, read: false, complete: false, said: say('unread', { source: label }) };
        if (source.required_rows && !Array.isArray(pick(task.output, source.rows)) || source.errors_path && pick(task.output, source.errors_path)?.length)
          return { source, items: [], read: false, complete: false, said: say('unread', { source: label }) };
        items.push(...itemsOf(source, task.output));
        cursor = source.pagination ? pick(task.output, source.pagination.next_cursor) ?? null : null;
        if (!cursor) return { source, items, read: true, complete: true };
        if (seen.has(cursor)) break;
        seen.add(cursor);
      }
      return { source, items, read: true, complete: false, next_cursor: cursor, said: say('incomplete', { source: label }) };
    } catch {
      return { source, items: [], read: false, complete: false, said: say('unread', { source: label }) };
    }
  }));
  const bySource = new Map(read.map(entry => [entry.source.id, entry.items]));
  const items = [];
  for (const { source, items: own } of read) {
    const copies = source.copies_of
      ? new Set((bySource.get(source.copies_of.source) ?? []).map(item => readRecord(`${source.copies_of.record_type}:${item.source_id}`)?.[source.copies_of.field]).filter(Boolean).map(String))
      : null;
    for (const item of own) if (!copies?.has(item.source_id)) items.push(item);
  }
  items.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.title.localeCompare(b.title));
  return {
    ...span, items,
    sources: read.map(({ source, read: ok, connected, said, complete, next_cursor }) => ({
      id: source.id, label: source.look?.label ?? source.id, read: ok,
      ...(source.event_properties ? { event_properties: source.event_properties } : {}),
      ...(source.event_colors ? { event_colors: source.event_colors } : {}),
      ...(source.event_colors_unavailable ? { event_colors_unavailable: true } : {}),
      ...(source.base_source ? { base_source: source.base_source, look: source.look, selection: source.selection, calendar_actions: source.calendar_actions, actions: source.actions, move: source.move, connect: source.connect, unavailable: source.unavailable, writable: source.writable, access_role: source.access_role } : {}),
      ...(connected === false ? { connected } : {}), ...(said ? { said } : {}),
      ...(complete === undefined ? {} : { complete, next_cursor }),
    })),
  };
}

export const isCalendarPath = path => path === '/calendar';
