import { describe, expect, it } from 'vitest';
import { decodeRecordingCapturePolicy } from './recording-session';

describe('record-video capture policy', () => {
  it('reads scheduler-gap and journal-lease durations from DATA', () => {
    expect(decodeRecordingCapturePolicy({
      maximum_sample_gap_ms: 750, journal_lease_ms: 12_000, journal_heartbeat_ms: 2_000,
    })).toEqual({ maximumSampleGapMs: 750, journalLeaseMs: 12_000, journalHeartbeatMs: 2_000 });
  });

  it('rejects non-positive policy values instead of disabling safety', () => {
    expect(decodeRecordingCapturePolicy({
      maximum_sample_gap_ms: 0, journal_lease_ms: -1, journal_heartbeat_ms: 0,
    })).toEqual({ maximumSampleGapMs: 500, journalLeaseMs: 5_000, journalHeartbeatMs: 1_000 });
  });

  it('keeps the heartbeat inside the owner lease so a live capture is never recovered early', () => {
    expect(decodeRecordingCapturePolicy({ journal_lease_ms: 4_000, journal_heartbeat_ms: 9_000 }))
      .toMatchObject({ journalLeaseMs: 4_000, journalHeartbeatMs: 2_000 });
  });
});
