import type { MeetingCaptureStartEvent } from '../read-data/capture-policy';

export type MeetingJoinRecordingInvocation = MeetingCaptureStartEvent & {
  invocationId: string;
  initiatedAt: string;
  expiresAt: string;
  runtimeSessionId: string;
  /** Inert source metadata; only the short-lived invocation above can trigger capture. */
  calendarEvent: MeetingCalendarContext;
};

export type MeetingCalendarContext = {
  source: string;
  sourceId: string;
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  url: string | null;
  /** Exact source incarnation when the calendar is supplied by a connection. */
  sourceGeneration?: string;
  /** The people invited, as the calendar names them; kept so the recorded meeting can be found by who was in it. */
  attendees?: MeetingAttendee[];
};

export type MeetingAttendee = { name?: string; email?: string };

/** At most this many attendees travel with one meeting; the calendar read is bounded by the same number (src/calendar.json). */
export const MEETING_ATTENDEES_MOST = 50;

function readMeetingAttendees(value: unknown): MeetingAttendee[] {
  if (!Array.isArray(value)) return [];
  const people: MeetingAttendee[] = [];
  for (const entry of value) {
    if (people.length >= MEETING_ATTENDEES_MOST) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { name, email } = entry as Record<string, unknown>;
    const person: MeetingAttendee = {
      ...(typeof name === 'string' && name.trim() ? { name: name.trim().slice(0, 200) } : {}),
      ...(typeof email === 'string' && email.trim() ? { email: email.trim().slice(0, 320) } : {}),
    };
    if (person.name || person.email) people.push(person);
  }
  return people;
}

export function readMeetingCalendarContext(value: unknown): MeetingCalendarContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const sourceId = row.sourceId ?? row.source_id, eventId = row.eventId ?? row.id;
  const startsAt = row.startsAt ?? row.starts_at, endsAt = row.endsAt ?? row.ends_at;
  const url = row.url ?? row.conference_url;
  const sourceGeneration = row.sourceGeneration ?? row.source_generation;
  const attendees = readMeetingAttendees(row.attendees);
  if (![row.source, sourceId, eventId, row.title, startsAt].every(item => typeof item === 'string' && item.trim())) return null;
  if (!Number.isFinite(Date.parse(startsAt as string))) return null;
  if (endsAt != null && (typeof endsAt !== 'string' || !Number.isFinite(Date.parse(endsAt)) || Date.parse(endsAt) <= Date.parse(startsAt as string))) return null;
  if (url != null) {
    if (typeof url !== 'string') return null;
    try { if (!['https:', 'http:'].includes(new URL(url).protocol)) return null; } catch { return null; }
  }
  if (sourceGeneration !== undefined && (typeof sourceGeneration !== 'string' || !sourceGeneration.trim())) return null;
  return {
    source: (row.source as string).trim(), sourceId: (sourceId as string).trim(), eventId: (eventId as string).trim(),
    title: (row.title as string).trim(), startsAt: startsAt as string, endsAt: (endsAt as string | null | undefined) ?? null,
    url: (url as string | null | undefined) ?? null,
    ...(typeof sourceGeneration === 'string' ? { sourceGeneration } : {}),
    ...(attendees.length ? { attendees } : {}),
  };
}

/** A calendar item (src/calendar.mjs) as the context a recording is tied to: the one place an item's fields become a meeting. */
export function meetingContextOfCalendarItem(
  item: { id: string; source: string; source_id: string; title: string; starts_at: string; ends_at: string | null; conference_url?: string | null; link?: string | null; attendees?: MeetingAttendee[] },
  sourceGeneration?: string,
): MeetingCalendarContext | null {
  return readMeetingCalendarContext({
    source: item.source, source_id: item.source_id, id: item.id, title: item.title, starts_at: item.starts_at, ends_at: item.ends_at,
    source_generation: sourceGeneration, conference_url: item.conference_url ?? item.link ?? null, attendees: item.attendees,
  });
}

/** The result kept beside the recording's file so the one search finds the meeting (src/search.json lane meeting-details). A recording tied to no meeting keeps an empty value, which holds no words. */
export const MEETING_RESULT_KIND = 'meeting';
export function meetingResultOf(context: MeetingCalendarContext | null): Record<string, unknown> {
  if (!context) return {};
  const attendees = context.attendees ?? [];
  return {
    title: context.title, starts_at: context.startsAt, ends_at: context.endsAt, attendees,
    search_text: [context.title, ...attendees.flatMap(person => [person.name, person.email])].filter(Boolean).join('\n'),
  };
}

/** Shared record-row association lifecycle used by the recordings owner. */
export function attachMeetingContext<T extends Record<string, unknown>>(row: T, value: unknown): T & { meetingEventContext: MeetingCalendarContext } {
  const context = readMeetingCalendarContext(value);
  if (!context) throw new Error('Choose a valid calendar event with its source identity and start time.');
  return { ...row, meetingEventContext: context };
}

export function detachMeetingContext<T extends Record<string, unknown>>(row: T): Omit<T, 'meetingEventContext'> {
  const { meetingEventContext: _context, ...remaining } = row;
  return remaining as Omit<T, 'meetingEventContext'>;
}

const MAX_INVOCATION_AGE_MS = 2 * 60 * 1000;
// A saved screen input is restored in a new document. It may carry context,
// but it cannot carry a permission-triggering action into that new session.
let heldRuntimeSessionId: string | null = null;
/** This session's id, made on first use: a Worker refuses randomness while its modules load. */
const runtimeSessionId = () => (heldRuntimeSessionId ??= crypto.randomUUID());
const issued = new Map<string, { value: MeetingJoinRecordingInvocation; current: () => boolean }>();

/** Create a short-lived, explicit signal for one Trillion-initiated Join call action. */
export function createMeetingJoinRecordingInvocation(calendarEvent: MeetingCalendarContext, now = Date.now(), current = () => true): MeetingJoinRecordingInvocation {
  const context = readMeetingCalendarContext(calendarEvent);
  if (!context) {
    throw new TypeError('A current calendar event identity is required to start a meeting recording.');
  }
  for (const [id, held] of issued) if (Date.parse(held.value.expiresAt) <= now || !held.current()) issued.delete(id);
  const value: MeetingJoinRecordingInvocation = Object.freeze({
    kind: 'meeting-join-initiated',
    throughApp: true,
    invocationId: crypto.randomUUID(),
    initiatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + MAX_INVOCATION_AGE_MS).toISOString(),
    runtimeSessionId: runtimeSessionId(),
    calendarEvent: Object.freeze(context),
  });
  issued.set(value.invocationId, { value, current });
  return value;
}

/** A carried invocation can only start capture shortly after the Join call action that created it. */
export function isFreshMeetingJoinRecordingInvocation(
  value: unknown,
  now = Date.now(),
): value is MeetingJoinRecordingInvocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const invocation = value as Partial<MeetingJoinRecordingInvocation>;
  if (invocation.kind !== 'meeting-join-initiated' || invocation.throughApp !== true
    || invocation.runtimeSessionId !== runtimeSessionId()
    || typeof invocation.invocationId !== 'string' || !invocation.invocationId
    || typeof invocation.initiatedAt !== 'string' || typeof invocation.expiresAt !== 'string'
    || !readMeetingCalendarContext(invocation.calendarEvent)) return false;
  const held = issued.get(invocation.invocationId);
  if (!held || !held.current() || Object.keys(invocation).length !== Object.keys(held.value).length
    || Object.keys(held.value).some(key => key === 'calendarEvent'
      ? JSON.stringify(invocation.calendarEvent) !== JSON.stringify(held.value.calendarEvent)
      : invocation[key as keyof MeetingJoinRecordingInvocation] !== held.value[key as keyof MeetingJoinRecordingInvocation])) return false;
  const initiatedAt = Date.parse(invocation.initiatedAt);
  const expiresAt = Date.parse(invocation.expiresAt);
  return Number.isFinite(initiatedAt) && Number.isFinite(expiresAt)
    && initiatedAt <= now && expiresAt > now && expiresAt - initiatedAt <= MAX_INVOCATION_AGE_MS;
}
