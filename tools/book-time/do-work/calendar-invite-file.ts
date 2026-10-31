// tools/book-time/do-work/calendar-invite-file.ts
//
// A calendar invitation as a file (RFC 5545 iCalendar, METHOD REQUEST or CANCEL) that any mail client turns
// into an event: the route a booking takes onto the host's calendar when no calendar connection is held,
// and the attachment every confirmation carries so the attendee can add it in one tap.
// The organizer rule: the HOST is the organizer, so the host's own calendar shows the event with no
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
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
const text = (value: string) => value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Lines longer than 75 octets are folded with CRLF + space (RFC 5545 3.1).
function fold(line: string): string {
  if (line.length <= 74) return line;
  const chunks = [line.slice(0, 74)];
  for (let rest = line.slice(74); rest.length; rest = rest.slice(73)) chunks.push(` ${rest.slice(0, 73)}`);
  return chunks.join('\r\n');
}
// ';CN=Name:mailto:x' with a name, ':mailto:x' without one.
const who = (person: InvitePerson) => `${person.name ? `;CN=${text(person.name)}` : ''}:mailto:${person.email}`;

export function calendarInviteFile(input: CalendarInviteInput): string {
  const cancelled = input.method === 'CANCEL';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//book-time//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${input.method}`,
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${utc(input.now_ms)}`,
    `DTSTART:${utc(input.start_ms)}`,
    `DTEND:${utc(input.end_ms)}`,
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
