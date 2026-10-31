import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarInviteFile } from '../do-work/calendar-invite-file.ts';

const base = {
  uid: 'booking-1@example.test',
  start_ms: Date.UTC(2026, 7, 12, 15, 0, 0),
  end_ms: Date.UTC(2026, 7, 12, 15, 30, 0),
  summary: 'Intro call, with Jane; "bring notes"',
  organizer: { name: 'Sam Baker', email: 'host@example.test' },
  attendees: [{ name: 'Jane Rivera', email: 'guest@example.test' }, { email: 'second@example.test' }],
  method: 'REQUEST',
  sequence: 0,
  now_ms: Date.UTC(2026, 7, 1, 12, 0, 0),
};

test('a request is a calendar file with the host as organizer and everyone else an attendee, times in UTC', () => {
  const file = calendarInviteFile({ ...base, reminder_minutes: [60] });
  const lines = file.replace(/\r\n /g, '').split('\r\n');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.ok(lines.includes('METHOD:REQUEST'));
  assert.ok(lines.includes('DTSTART:20260812T150000Z'));
  assert.ok(lines.includes('DTEND:20260812T153000Z'));
  assert.ok(lines.includes('DTSTAMP:20260801T120000Z'));
  assert.ok(lines.includes('STATUS:CONFIRMED'));
  assert.ok(lines.includes('ORGANIZER;CN=Sam Baker:mailto:host@example.test'));
  assert.equal(lines.filter(line => line.startsWith('ATTENDEE')).length, 2);
  assert.ok(lines.includes('ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:second@example.test'));
  assert.ok(lines.includes('TRIGGER:-PT60M'));
  assert.ok(file.endsWith('END:VCALENDAR\r\n'));
});

test('text is escaped and long lines are folded at 75 characters', () => {
  const file = calendarInviteFile({ ...base, description: 'x'.repeat(200) });
  const slash = String.fromCharCode(92); // the escape character
  assert.ok(file.includes(`SUMMARY:Intro call${slash}, with Jane${slash}; "bring notes"`));
  for (const line of file.split('\r\n')) assert.ok(line.length <= 75, line);
  assert.equal(file.replace(/\r\n /g, '').split('\r\n').find(line => line.startsWith('DESCRIPTION:')), `DESCRIPTION:${'x'.repeat(200)}`);
});

test('a cancel keeps the uid, raises the sequence, and carries no reminders', () => {
  const file = calendarInviteFile({ ...base, method: 'CANCEL', sequence: 2, reminder_minutes: [60] });
  assert.ok(file.includes('METHOD:CANCEL'));
  assert.ok(file.includes('STATUS:CANCELLED'));
  assert.ok(file.includes('SEQUENCE:2'));
  assert.ok(file.includes('UID:booking-1@example.test'));
  assert.ok(!file.includes('VALARM'));
});
