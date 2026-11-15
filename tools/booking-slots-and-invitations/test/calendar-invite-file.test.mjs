import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarInviteFile } from '../do-work/calendar-invite-file.ts';

const invite = (overrides = {}) => ({
  uid: 'booking-123@example.test',
  start_ms: Date.UTC(2026, 10, 7, 16),
  end_ms: Date.UTC(2026, 10, 7, 17),
  summary: 'Consultation',
  description: 'A public synthetic fixture',
  location: 'Room 2',
  organizer: { name: 'Host', email: 'host@example.test' },
  attendees: [{ name: 'Guest', email: 'guest@example.test' }],
  method: 'REQUEST',
  sequence: 0,
  now_ms: Date.UTC(2026, 10, 1),
  reminder_minutes: [15],
  ...overrides,
});

test('a request keeps the organizer, attendee, UID and reminder shape', () => {
  const file = calendarInviteFile(invite());
  const unfolded = file.replace(/\r\n[ \t]/g, '');
  assert.match(unfolded, /METHOD:REQUEST\r\n/);
  assert.match(unfolded, /UID:booking-123@example\.test\r\n/);
  assert.match(unfolded, /ORGANIZER;CN=Host:mailto:host@example\.test\r\n/);
  assert.match(unfolded, /ATTENDEE;[^\r\n]*;CN=Guest:mailto:guest@example\.test\r\n/);
  assert.match(unfolded, /SEQUENCE:0\r\n/);
  assert.match(unfolded, /TRIGGER:-PT15M\r\n/);
});

test('a higher sequence request updates the same UID and cancellation removes it', () => {
  const update = calendarInviteFile(invite({ sequence: 3, start_ms: Date.UTC(2026, 10, 7, 18), end_ms: Date.UTC(2026, 10, 7, 19) }));
  const cancel = calendarInviteFile(invite({ method: 'CANCEL', sequence: 4 }));
  assert.match(update, /UID:booking-123@example\.test\r\n/);
  assert.match(update, /SEQUENCE:3\r\n/);
  assert.match(update, /DTSTART:20261107T180000Z\r\n/);
  assert.match(cancel, /METHOD:CANCEL\r\n/);
  assert.match(cancel, /UID:booking-123@example\.test\r\n/);
  assert.match(cancel, /STATUS:CANCELLED\r\n/);
  assert.doesNotMatch(cancel, /BEGIN:VALARM/);
});

test('a zero-duration event omits DTEND and a negative duration is rejected', () => {
  const start_ms = Date.UTC(2026, 10, 7, 16);
  const zeroDuration = calendarInviteFile(invite({ start_ms, end_ms: start_ms }));
  assert.match(zeroDuration, /DTSTART:20261107T160000Z\r\n/);
  assert.doesNotMatch(zeroDuration, /DTEND:/);
  assert.throws(() => calendarInviteFile(invite({ start_ms, end_ms: start_ms - 1 })), /cannot precede/);
});

test('text line endings are escaped while parameter punctuation stays within CN', () => {
  const file = calendarInviteFile(invite({
    summary: 'first\r\nsecond\nthird\rfourth',
    organizer: { name: 'Doe, Jane; "Host"', email: 'host@example.test' },
  }));
  assert.match(file, /SUMMARY:first\\nsecond\\nthird\\nfourth\r\n/);
  assert.match(file, /ORGANIZER;CN="Doe, Jane; \^'Host\^'":mailto:host@example\.test\r\n/);
  assert.equal(file.includes('first\r\nsecond'), false);
});

test('structural UID and organizer or attendee email values reject line and control injection', () => {
  for (const bad of ['uid\r\nMETHOD:CANCEL', 'uid\nSUMMARY:Injected', 'uid\0tail']) {
    assert.throws(() => calendarInviteFile(invite({ uid: bad })), /control characters/);
  }
  for (const bad of ['host@example.test\r\nATTENDEE:mailto:evil@example.test', 'host@example.test\nX-ATTACK:yes', 'host@example.test\0']) {
    assert.throws(() => calendarInviteFile(invite({ organizer: { email: bad } })), /control characters/);
    assert.throws(() => calendarInviteFile(invite({ attendees: [{ email: bad }] })), /control characters/);
  }
});

test('folding counts UTF-8 octets, preserves code points, and unfolds to the same property', () => {
  const summary = `${'a'.repeat(68)}😀${'é'.repeat(30)}終${'z'.repeat(20)}`;
  const file = calendarInviteFile(invite({ summary }));
  const physical = file.split('\r\n').slice(0, -1);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const line of physical) {
    decoder.decode(new TextEncoder().encode(line));
    assert.ok(new TextEncoder().encode(line).length <= 75, `line has ${new TextEncoder().encode(line).length} octets`);
  }
  const unfolded = file.replace(/\r\n[ \t]/g, '');
  assert.ok(unfolded.includes(`SUMMARY:${summary}\r\n`));
  assert.ok(file.includes('😀'));
});

test('runtime method, sequence, timestamp, duration and reminder values are validated', () => {
  for (const method of ['PATCH', 'REQUEST\r\nMETHOD:CANCEL']) assert.throws(() => calendarInviteFile(invite({ method })), /method/);
  for (const sequence of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => calendarInviteFile(invite({ sequence })), /sequence/);
  for (const now_ms of [Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => calendarInviteFile(invite({ now_ms })), /timestamp/);
  assert.throws(() => calendarInviteFile(invite({ end_ms: invite().start_ms - 1 })), /cannot precede/);
  for (const reminder_minutes of [[-1], [1.5], [Number.NaN], ['15;END:VALARM']]) assert.throws(() => calendarInviteFile(invite({ reminder_minutes })), /reminders/);
});
