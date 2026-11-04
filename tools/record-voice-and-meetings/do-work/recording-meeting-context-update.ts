import {
  attachMeetingContext,
  detachMeetingContext,
  readMeetingCalendarContext,
  type MeetingCalendarContext,
} from './meeting-join-recording';

type RecordingRow = Record<string, unknown>;

const sameContext = (left: MeetingCalendarContext | null, right: MeetingCalendarContext | null) =>
  JSON.stringify(left) === JSON.stringify(right);

function exactRecording(rows: RecordingRow[], recordId: string, recordedFileId: string): RecordingRow {
  if (typeof recordId !== 'string' || !recordId.trim() || recordId !== recordedFileId) {
    throw new Error('Choose the same recording identity for the meeting association.');
  }
  const matches = rows.filter(candidate => Boolean(candidate && typeof candidate === 'object' && candidate.id === recordId));
  if (matches.length > 1) throw new Error('This recording identity is ambiguous. Refresh the recording library.');
  const row = matches[0];
  if (!row) throw new Error('This recording is no longer in your recordings.');
  const storedFileRef = row.storedFileRef;
  // Older hosted recordings can retain their Namespace sourceRef without a local playback descriptor.
  // Do not require local-cache metadata to edit the canonical recording; an explicit file pointer must agree.
  if (storedFileRef != null && (typeof storedFileRef !== 'object' || Array.isArray(storedFileRef)
    || (Object.hasOwn(storedFileRef, 'recorded_file_id')
      && (storedFileRef as Record<string, unknown>).recorded_file_id !== recordedFileId))) {
    throw new Error('This recording’s original file identity could not be verified.');
  }
  return row;
}

function currentContext(row: RecordingRow): MeetingCalendarContext | null {
  if (!Object.hasOwn(row, 'meetingEventContext') || row.meetingEventContext == null) return null;
  const context = readMeetingCalendarContext(row.meetingEventContext);
  if (!context) throw new Error('This recording’s meeting association could not be read.');
  return context;
}

/** Apply an idempotent compare-and-set to the exact saved recording and its original file identity. */
export function updateRecordingMeetingContextRows(
  value: unknown,
  input: {
    recordId: string;
    recordedFileId: string;
    expectedContext: unknown;
    nextContext: unknown;
  },
): RecordingRow[] {
  if (!Array.isArray(value)) throw new Error('The recording library could not be read.');
  const rows = value as RecordingRow[];
  const current = exactRecording(rows, input.recordId, input.recordedFileId);
  const expected = input.expectedContext == null ? null : readMeetingCalendarContext(input.expectedContext);
  if (input.expectedContext != null && !expected) throw new Error('The expected meeting association is invalid.');
  const next = input.nextContext == null ? null : readMeetingCalendarContext(input.nextContext);
  if (input.nextContext != null && !next) throw new Error('Choose a valid calendar event with its source identity and start time.');
  const actual = currentContext(current);

  // A repeated successful request is harmless after a lost response.
  if (sameContext(actual, next)) return rows;
  if (!sameContext(actual, expected)) {
    throw Object.assign(new Error('This recording’s meeting association changed. Reopen it before changing it again.'), { status: 409 });
  }
  return rows.map(row => !row || typeof row !== 'object' || row.id !== input.recordId ? row : next
    ? attachMeetingContext(row, next)
    : detachMeetingContext(row));
}
