import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';

import {
  attachMeetingContext,
  createMeetingJoinRecordingInvocation,
  detachMeetingContext,
  isFreshMeetingJoinRecordingInvocation,
  readMeetingCalendarContext,
} from '../../../do-work/meeting-join-recording.ts';

describe('meeting Join call recording invocation', () => {
  it('creates a fresh, explicitly initiated invocation with a short expiry', () => {
    const now = Date.parse('2026-10-13T12:00:00.000Z');
    const invocation = createMeetingJoinRecordingInvocation({ source: 'calendar:primary', sourceId: 'acct:1/calendar:primary', eventId: 'same-title-a', title: 'Planning', startsAt: '2026-10-13T12:00:00.000Z', endsAt: '2026-10-13T13:00:00.000Z', url: 'https://meet.example/a' }, now);

    expect(invocation).toMatchObject({
      kind: 'meeting-join-initiated',
      throughApp: true,
      initiatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 2 * 60 * 1000).toISOString(),
    });
    expect(invocation.invocationId).toBeTruthy();
    expect(isFreshMeetingJoinRecordingInvocation(invocation, now + 1)).toBe(true);
  });

  it('rejects expired, future, malformed, and non-Trillion events', () => {
    const now = Date.parse('2026-10-13T12:00:00.000Z');
    const invocation = createMeetingJoinRecordingInvocation({ source: 'calendar:primary', sourceId: 'acct:1/calendar:primary', eventId: 'same-title-a', title: 'Planning', startsAt: '2026-10-13T12:00:00.000Z', endsAt: null, url: null }, now);

    expect(isFreshMeetingJoinRecordingInvocation(invocation, now + 2 * 60 * 1000)).toBe(false);
    expect(isFreshMeetingJoinRecordingInvocation(invocation, now - 1)).toBe(false);
    expect(isFreshMeetingJoinRecordingInvocation({ ...invocation, throughApp: false }, now + 1)).toBe(false);
    expect(isFreshMeetingJoinRecordingInvocation({ ...invocation, expiresAt: 'invalid' }, now + 1)).toBe(false);
  });

  it('keeps same-title events distinct and requires real source identity and valid time', () => {
    const a = createMeetingJoinRecordingInvocation({ source: 'google', sourceId: 'account-a/calendar-1', eventId: 'event-a', title: 'Planning', startsAt: '2026-10-13T12:00:00.000Z', endsAt: null, url: null });
    const b = createMeetingJoinRecordingInvocation({ source: 'google', sourceId: 'account-b/calendar-1', eventId: 'event-b', title: 'Planning', startsAt: '2026-10-13T12:00:00.000Z', endsAt: null, url: null });
    expect(a.calendarEvent).not.toEqual(b.calendarEvent);
    expect(() => createMeetingJoinRecordingInvocation({ ...a.calendarEvent, sourceId: '', eventId: '' })).toThrow(/calendar event identity/i);
  });

  it('attaches, reads, edits, and detaches meeting metadata without changing the recording row', () => {
    const original = { id: 'recording:one', label: 'My recording', notes: 'Keep these' };
    const first = attachMeetingContext(original, { source: 'google', sourceId: 'account:a/calendar:one', eventId: 'event:one', title: 'Planning', startsAt: '2026-10-13T12:00:00.000Z', endsAt: null, url: null });
    expect(readMeetingCalendarContext(first.meetingEventContext)?.eventId).toBe('event:one');
    const edited = attachMeetingContext(first, { source: 'google', sourceId: 'account:b/calendar:one', eventId: 'event:two', title: 'Planning', startsAt: '2026-10-13T12:00:00.000Z', endsAt: null, url: null });
    expect(readMeetingCalendarContext(edited.meetingEventContext)?.sourceId).toBe('account:b/calendar:one');
    expect(detachMeetingContext(edited)).toEqual(original);
  });
});
