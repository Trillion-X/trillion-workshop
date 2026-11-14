import { describe, expect, it, vi } from 'vitest';
import {
  orderedChunkRefs,
  captureJournalRecoveryState,
  RecordingChunkWriteError,
  shouldReplaceCaptureJournal,
  storedRecordedFileRef,
  storeRecordingChunkWithRetry,
  type CaptureJournal,
} from './recorded-file-store';

const input = {
  recordingId: 'recording:test', sequence: 4, mediaType: 'video/webm',
  chunk: new Blob(['bytes']), observedAt: '2026-09-10T00:00:00.000Z',
};

describe('recording chunk persistence', () => {
  const journal = (revision: number, phase = 'recording'): CaptureJournal => ({
    recording_id: 'recording:test', recorded_file_id: 'recorded-file:test', recorded_at: null,
    phase, capture_kind: 'video', media_type: 'video/webm', completion_reason_ref: null,
    completion_source_ref: null, completion_observed_at: null, active_duration_ms: 0,
    expected_sequences: [0], stored_sequences: [0], failed_sequences: [],
    owner_instance_ref: 'capture-owner:test', owner_lease_expires_at: '2026-09-10T00:00:05.000Z',
    journal_revision: revision, updated_at: '2026-09-10T00:00:00.000Z',
  });

  it('retains stable file identity and time in the local playback reference', () => {
    expect(storedRecordedFileRef({
      recordingId: 'recording:test', recordedFileId: 'recorded-file:test',
      recordedAt: '2026-09-10T00:00:00.000Z', mediaType: 'video/webm',
      chunkRefs: [{ key: 'recording:test:chunk:0', byte_length: 5 }],
    })).toMatchObject({
      recording_id: 'recording:test', recorded_file_id: 'recorded-file:test',
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
  it('orders asynchronously completed chunks by their declared sequence', () => {
    expect(orderedChunkRefs([
      { key: 'recording:test:chunk:10', byte_length: 1 },
      { key: 'recording:test:chunk:2', byte_length: 1 },
      { key: 'recording:test:chunk:0', byte_length: 1 },
    ]).map((ref) => ref.key)).toEqual([
      'recording:test:chunk:0', 'recording:test:chunk:2', 'recording:test:chunk:10',
    ]);
  });

  it('retries only the failed sequence and returns its stable idempotent key', async () => {
    const writer = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({ key: 'recording:test:chunk:4', byte_length: 5 });
    await expect(storeRecordingChunkWithRetry(input, 3, writer)).resolves.toEqual({
      key: 'recording:test:chunk:4', byte_length: 5,
    });
    expect(writer).toHaveBeenCalledTimes(2);
    expect(writer.mock.calls.every(([attempt]) => attempt.sequence === 4)).toBe(true);
  });

  it('makes permanent sequence loss explicit after the configured attempts', async () => {
    const writer = vi.fn().mockRejectedValue(new Error('quota denied'));
    await expect(storeRecordingChunkWithRetry(input, 2, writer)).rejects.toMatchObject({
      name: 'RecordingChunkWriteError', sequence: 4, attempts: 2,
    } satisfies Partial<RecordingChunkWriteError>);
    expect(writer).toHaveBeenCalledTimes(2);
  });
});
