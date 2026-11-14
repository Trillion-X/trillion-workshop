import { describe, expect, it } from 'vitest';
import { updateRecordingMeetingContextRows } from './recording-meeting-context-update';

const fileId = 'media-record:one';
const current = {
  source: 'google', sourceId: 'calendar:one', eventId: 'event:one', title: 'Planning',
  startsAt: '2026-10-14T10:00:00.000Z', endsAt: null, url: null,
};
const next = { ...current, eventId: 'event:two', title: 'Review' };
const row = (meetingEventContext?: unknown) => ({
  id: fileId,
  storedFileRef: { kind: 'local-playback.indexeddb-chunks', recorded_file_id: fileId },
  ...(meetingEventContext === undefined ? {} : { meetingEventContext }),
});

describe('recording meeting context owner', () => {
  it('compares the expected context before changing the exact recording and file', () => {
    const rows = [row(current), { ...row(), id: 'media-record:other', storedFileRef: { recorded_file_id: 'media-record:other' } }];
    const updated = updateRecordingMeetingContextRows(rows, {
      recordId: fileId, recordedFileId: fileId, expectedContext: current, nextContext: next,
    });

    expect(updated[0].meetingEventContext).toEqual(next);
    expect(updated[1]).toBe(rows[1]);
    expect(rows[0].meetingEventContext).toEqual(current);
  });

  it('rejects stale expected context without changing the row', () => {
    const rows = [row(current)];
    expect(() => updateRecordingMeetingContextRows(rows, {
      recordId: fileId, recordedFileId: fileId, expectedContext: null, nextContext: next,
    })).toThrow(/association changed/i);
    expect(rows[0].meetingEventContext).toEqual(current);
  });

  it('clears only when the attached context still matches the expected context', () => {
    const rows = [row(current)];
    const cleared = updateRecordingMeetingContextRows(rows, {
      recordId: fileId, recordedFileId: fileId, expectedContext: current, nextContext: null,
    });
    expect(Object.hasOwn(cleared[0], 'meetingEventContext')).toBe(false);
    expect(rows[0].meetingEventContext).toEqual(current);
  });

  it('rejects mismatched request ids and a row whose original file id differs', () => {
    expect(() => updateRecordingMeetingContextRows([row()], {
      recordId: fileId, recordedFileId: 'media-record:other', expectedContext: null, nextContext: current,
    })).toThrow(/same recording identity/i);
    expect(() => updateRecordingMeetingContextRows([{
      id: fileId, storedFileRef: { recorded_file_id: 'media-record:other' },
    }], {
      recordId: fileId, recordedFileId: fileId, expectedContext: null, nextContext: current,
    })).toThrow(/original file identity/i);
  });

  it('allows an identical replay after a successful set', () => {
    const rows = [row(current)];
    expect(updateRecordingMeetingContextRows(rows, {
      recordId: fileId, recordedFileId: fileId, expectedContext: null, nextContext: current,
    })).toBe(rows);
  });
  it('refuses ambiguous duplicate recording identities before changing anything', () => {
    const rows = [row(current), row()];
    expect(() => updateRecordingMeetingContextRows(rows, { recordId: fileId, recordedFileId: fileId,
      expectedContext: current, nextContext: next })).toThrow(/ambiguous/i);
    expect(rows[0].meetingEventContext).toEqual(current);
    expect(Object.hasOwn(rows[1], 'meetingEventContext')).toBe(false);
  });

});
