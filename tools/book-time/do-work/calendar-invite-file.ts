// The one owner of this file is tools/book-time/do-work/calendar-invite-file.ts. The shipped parts that need a
// self-contained copy (tools/booking-slots-and-invitations/do-work and tools/book-time/packages/calendar-booker/do-work)
// hold the same bytes; tools/book-time/test/calendar-invite-file-copies.test.mjs fails if they differ.
//
// A calendar invitation as a file (RFC 5545 iCalendar, METHOD REQUEST or CANCEL) that any mail client turns
// into an event: the route a booking takes onto the host's calendar when no calendar connection is held,
// and the attachment every confirmation carries so the attendee can add it in one tap. The organizer
// rule is proven in production: the HOST is the organizer, so the host's own calendar shows the event with no
// toggle, and everyone else is an attendee. Times are absolute instants, written in UTC.
//
// The same `uid` with a higher `sequence` updates an event (a new time) and METHOD:CANCEL removes it, so
// reschedule and cancel send the same file shape with the booking's uid.

export interface InvitePerson {
  name?: string;
  email: string;
}

export interface CalendarInviteInput {
  uid: string;
  start_ms: number;
  end_ms: number;
  summary: string;
  description?: string;
  location?: string;
  organizer: InvitePerson;
  attendees: InvitePerson[];
  // 'REQUEST' creates or updates, 'CANCEL' removes.
  method: 'REQUEST' | 'CANCEL';
  // bumps on every change to the same uid.
  sequence: number;
  now_ms: number;
  // minutes before the start at which calendars remind.
  reminder_minutes?: number[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const utc = (ms: number) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new TypeError('Calendar timestamps must be finite numbers');
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime()) || d.getUTCFullYear() < 0 || d.getUTCFullYear() > 9999) {
    throw new RangeError('Calendar timestamps must fit an RFC 5545 DATE-TIME');
  }
  return `${String(d.getUTCFullYear()).padStart(4, '0')}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
const assertString = (value: unknown, label: string) => {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
};
const assertNoControls = (value: string, label: string, allowNewlines = false) => {
  const controls = allowNewlines ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u : /[\u0000-\u001F\u007F-\u009F]/u;
  if (controls.test(value)) throw new TypeError(`${label} cannot contain control characters`);
};
const text = (value: string) => {
  assertString(value, 'Calendar text');
  assertNoControls(value, 'Calendar text', true);
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
};
const structural = (value: string, label: string) => {
  assertString(value, label);
  assertNoControls(value, label);
  return value;
};
const parameter = (value: string) => {
  assertString(value, 'Calendar participant name');
  assertNoControls(value, 'Calendar participant name', true);
  // RFC 6868 encoding keeps the value inside the CN parameter, including quotes and newlines.
  const escaped = value.replace(/\^/g, '^^').replace(/"/g, "^'").replace(/\r\n|\r|\n/g, '^n');
  return /[;,:"\\]/u.test(value) ? `"${escaped}"` : escaped;
};
// Lines longer than 75 octets are folded with CRLF + space (RFC 5545 3.1).
function fold(line: string): string {
  const points = Array.from(line);
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = '';
  let octets = 0;
  let budget = 74; // Keep the historical ASCII fold point; continuation space is counted below.
  for (const point of points) {
    const size = encoder.encode(point).length;
    if (octets + size > budget && chunk) {
      chunks.push(chunk);
      chunk = ' ';
      octets = 1;
      budget = 74;
    }
    chunk += point;
    octets += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks.join('\r\n');
}
// ';CN=Name:mailto:x' with a name, ':mailto:x' without one.
const who = (person: InvitePerson) => {
  if (!person || typeof person !== 'object') throw new TypeError('Calendar participant must be an object');
  const email = structural(person.email, 'Calendar participant email');
  return `${person.name ? `;CN=${parameter(person.name)}` : ''}:mailto:${email}`;
};

export function calendarInviteFile(input: CalendarInviteInput): string {
  if (!input || typeof input !== 'object') throw new TypeError('Calendar invite input must be an object');
  if (input.method !== 'REQUEST' && input.method !== 'CANCEL') throw new TypeError('Calendar method must be REQUEST or CANCEL');
  if (!Number.isInteger(input.sequence) || input.sequence < 0) throw new TypeError('Calendar sequence must be a non-negative integer');
  structural(input.uid, 'Calendar UID');
  if (typeof input.start_ms !== 'number' || typeof input.end_ms !== 'number' || input.end_ms < input.start_ms) {
    throw new TypeError('Calendar event end cannot precede its start');
  }
  if (!Array.isArray(input.attendees)) throw new TypeError('Calendar attendees must be an array');
  if (input.reminder_minutes !== undefined && (!Array.isArray(input.reminder_minutes) || input.reminder_minutes.some((minutes) => !Number.isInteger(minutes) || minutes < 0))) {
    throw new TypeError('Calendar reminders must be non-negative integer minutes');
  }
  const cancelled = input.method === 'CANCEL';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//calendar-invite-file//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${input.method}`,
    'BEGIN:VEVENT',
    `UID:${text(structural(input.uid, 'Calendar UID'))}`,
    `DTSTAMP:${utc(input.now_ms)}`,
    `DTSTART:${utc(input.start_ms)}`,
    ...(input.end_ms === input.start_ms ? [] : [`DTEND:${utc(input.end_ms)}`]),
    `SUMMARY:${text(input.summary)}`,
    ...(input.description ? [`DESCRIPTION:${text(input.description)}`] : []),
    ...(input.location ? [`LOCATION:${text(input.location)}`] : []),
    `ORGANIZER${who(input.organizer)}`,
    ...input.attendees.map((person) => `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE${who(person)}`),
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    `SEQUENCE:${input.sequence}`,
    'TRANSP:OPAQUE',
    ...(cancelled ? [] : (input.reminder_minutes ?? []).flatMap((minutes) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(input.summary)}`, `TRIGGER:-PT${minutes}M`, 'END:VALARM'])),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
