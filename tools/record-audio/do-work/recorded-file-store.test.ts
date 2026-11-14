import { describe, expect, it, vi } from 'vitest';
import {
  captureJournalRecoveryState,
  orderedChunkRefs,
  RecordingChunkWriteError,
  shouldReplaceCaptureJournal,
  storedRecordedFileRef,
  storeRecordingChunkWithRetry,
  type CaptureJournal,
} from './recorded-file-store';

describe('record-audio recorded file store', () => {
  const journal = (revision: number, phase = 'recording'): CaptureJournal => ({
    recording_id: 'recording:a', recorded_file_id: 'recorded-file:a', recorded_at: null,
    phase, capture_kind: 'audio', media_type: 'audio/webm', completion_reason_ref: null,
    completion_source_ref: null, completion_observed_at: null, active_duration_ms: 0,
    expected_sequences: [0], stored_sequences: [0], failed_sequences: [],
    owner_instance_ref: 'capture-owner:a', owner_lease_expires_at: '2026-09-10T00:00:05.000Z',
    journal_revision: revision, updated_at: '2026-09-10T00:00:00.000Z',
  });

  it('retains stable file identity and time in the local playback reference', () => {
    expect(storedRecordedFileRef({
      recordingId: 'recording:a', recordedFileId: 'recorded-file:a',
      recordedAt: '2026-09-10T00:00:00.000Z', mediaType: 'audio/webm',
      chunkRefs: [{ key: 'recording:a:chunk:0', byte_length: 5 }],
    })).toMatchObject({
      recording_id: 'recording:a', recorded_file_id: 'recorded-file:a',
      recorded_at: '2026-09-10T00:00:00.000Z', byte_length: 5,
    });
  });

  it('refuses stale journal writes and resurrection after a terminal tombstone', () => {
    expect(shouldReplaceCaptureJournal(journal(4), journal(3, 'stopping'))).toBe(false);
    expect(shouldReplaceCaptureJournal(journal(4), journal(5, 'stopping'))).toBe(true);
    expect(shouldReplaceCaptureJournal(journal(5, 'saved'), journal(6, 'stopping'))).toBe(false);
  });

  it('migrates a legacy journal without a revision through the next valid write', () => {
    const legacy = { ...journal(4), journal_revision: undefined } as unknown as CaptureJournal;
    expect(shouldReplaceCaptureJournal(legacy, journal(1, 'interrupted'))).toBe(true);
  });

  it('does not interrupt a remounted local owner or another live owner lease', () => {
    const current = journal(4);
    expect(captureJournalRecoveryState(current, current.recording_id, Date.parse('2026-09-10T00:00:10.000Z')))
      .toBe('owned-here');
    expect(captureJournalRecoveryState(current, null, Date.parse('2026-09-10T00:00:04.000Z')))
      .toBe('leased-elsewhere');
    expect(captureJournalRecoveryState(current, null, Date.parse('2026-09-10T00:00:06.000Z')))
      .toBe('recover');
  });

  it('orders completed writes by sequence, not promise completion', () => {
    expect(orderedChunkRefs([
      { key: 'recording:a:chunk:2', byte_length: 2 },
      { key: 'recording:a:chunk:0', byte_length: 1 },
      { key: 'recording:a:chunk:1', byte_length: 3 },
    ]).map((chunk) => chunk.key)).toEqual([
      'recording:a:chunk:0', 'recording:a:chunk:1', 'recording:a:chunk:2',
    ]);
  });

  it('retries only the failed stable sequence', async () => {
    const writer = vi.fn()
      .mockRejectedValueOnce(new Error('disk busy'))
      .mockResolvedValue({ key: 'recording:a:chunk:4', byte_length: 2 });
    const input = {
      recordingId: 'recording:a', sequence: 4, mediaType: 'audio/webm',
      chunk: new Blob(['ok']), observedAt: '2026-09-10T00:00:00.000Z',
    };
    await expect(storeRecordingChunkWithRetry(input, 3, writer)).resolves.toEqual({
      key: 'recording:a:chunk:4', byte_length: 2,
    });
    expect(writer).toHaveBeenCalledTimes(2);
    expect(writer.mock.calls.every(([value]) => value.sequence === 4)).toBe(true);
  });

  it('reports the permanently missing sequence', async () => {
    const writer = vi.fn().mockRejectedValue(new Error('disk full'));
    const input = {
      recordingId: 'recording:a', sequence: 7, mediaType: 'audio/webm',
      chunk: new Blob(['x']), observedAt: '2026-09-10T00:00:00.000Z',
    };
    await expect(storeRecordingChunkWithRetry(input, 2, writer)).rejects.toMatchObject({
      name: 'RecordingChunkWriteError', sequence: 7, attempts: 2,
    } satisfies Partial<RecordingChunkWriteError>);
  });
});
