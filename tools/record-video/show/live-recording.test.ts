import { describe, expect, it, vi } from 'vitest';
import {
  currentLiveRecording,
  claimLiveRecordingFinalization,
  claimLiveRecordingStop,
  releaseLiveRecording,
  reopenLiveRecordingFinalization,
  subscribeToLiveRecording,
  tryAdoptLiveRecording,
  updateLiveRecording,
  type LiveRecording,
} from './live-recording';

function liveFor(recordingId: string): LiveRecording {
  return {
    session: {
      recordingId,
      recordedFileId: `recorded-file:${recordingId}`,
      recordedAt: null,
      mode: 'video',
      mediaType: 'video/webm',
      startedAtMs: 1_000,
      sequence: 0,
      chunkRefs: [],
      chunkWrites: [],
      chunkResults: new Map(),
      chunkFailures: new Map(),
      journalRevision: 0,
      ownerInstanceRef: `capture-owner:${recordingId}`,
      journalLeaseMs: 5_000,
      timing: { activeStartedAtMs: null, accumulatedActiveMs: 0 },
    },
    recorder: null,
    stream: null,
    cancelled: false,
    finalizing: false,
    phase: 'requesting',
    autoStopTimeout: null,
    silenceMonitorCleanup: null,
    completion: null,
    providerStopInvoked: false,
    countdownValue: null,
    teleprompter: null,
    completionReasonRefs: {
      manual: 'reason:manual', speech: 'reason:speech', silence: 'reason:silence',
      duration: 'reason:duration', providerEnd: 'reason:end', providerError: 'reason:error', cancel: 'reason:cancel', phrase: 'reason:phrase',
    },
  };
}

describe('record-video live-recording store', () => {
  it('starts empty', () => {
    expect(currentLiveRecording()).toBeNull();
  });

  it('adopts and exposes the live recording', () => {
    const live = liveFor('recording:a');
    expect(tryAdoptLiveRecording(live)).toBe(true);
    expect(currentLiveRecording()).toBe(live);
    releaseLiveRecording('recording:a');
  });

  it('releases only the matching recording id', () => {
    const live = liveFor('recording:a');
    expect(tryAdoptLiveRecording(live)).toBe(true);
    releaseLiveRecording('recording:other');
    expect(currentLiveRecording()).toBe(live);
    releaseLiveRecording('recording:a');
    expect(currentLiveRecording()).toBeNull();
  });

  it('notifies subscribers on adopt and release, and unsubscribes correctly', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLiveRecording(listener);
    expect(tryAdoptLiveRecording(liveFor('recording:a'))).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    releaseLiveRecording('recording:a');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(tryAdoptLiveRecording(liveFor('recording:b'))).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    releaseLiveRecording('recording:b');
  });

  it('a superseded session release cannot clear the newer live recording', () => {
    expect(tryAdoptLiveRecording(liveFor('recording:old'))).toBe(true);
    expect(tryAdoptLiveRecording(liveFor('recording:new'))).toBe(false);
    releaseLiveRecording('recording:old');
    expect(currentLiveRecording()).toBeNull();
  });

  it('reserves before permission so a second mounted panel cannot acquire another stream', () => {
    expect(tryAdoptLiveRecording(liveFor('recording:panel-a'))).toBe(true);
    expect(tryAdoptLiveRecording(liveFor('recording:panel-b'))).toBe(false);
    expect(currentLiveRecording()?.session.recordingId).toBe('recording:panel-a');
    releaseLiveRecording('recording:panel-a');
  });

  it('keeps two mounted views synchronized through countdown, pause, remount, and cleanup', () => {
    const viewA: Array<string | null> = [];
    const viewB: Array<string | null> = [];
    const unsubscribeA = subscribeToLiveRecording(() => viewA.push(currentLiveRecording()?.phase ?? null));
    const unsubscribeB = subscribeToLiveRecording(() => viewB.push(currentLiveRecording()?.phase ?? null));
    expect(tryAdoptLiveRecording(liveFor('recording:a'))).toBe(true);
    expect(updateLiveRecording('recording:a', (recording) => { recording.phase = 'countdown'; })).toBe(true);
    expect(updateLiveRecording('recording:a', (recording) => { recording.phase = 'recording'; })).toBe(true);
    expect(updateLiveRecording('recording:a', (recording) => { recording.phase = 'paused'; })).toBe(true);
    expect(updateLiveRecording('recording:a', (recording) => { recording.phase = 'recording'; })).toBe(true);
    expect(releaseLiveRecording('recording:a')).toBe(true);
    expect(releaseLiveRecording('recording:a')).toBe(false);
    expect(viewA).toEqual(['requesting', 'countdown', 'recording', 'paused', 'recording', null]);
    expect(viewB).toEqual(viewA);
    unsubscribeA();
    unsubscribeB();
    expect(currentLiveRecording()).toBeNull();
  });

  it('cancels during countdown once and makes late cleanup harmless after remount', () => {
    const phases: Array<string | null> = [];
    const unsubscribe = subscribeToLiveRecording(() => phases.push(currentLiveRecording()?.phase ?? null));
    expect(tryAdoptLiveRecording(liveFor('recording:a'))).toBe(true);
    expect(updateLiveRecording('recording:a', (recording) => { recording.phase = 'countdown'; })).toBe(true);
    expect(updateLiveRecording('recording:a', (recording) => { recording.cancelled = true; })).toBe(true);

    // Panel A starts the countdown; Panel B cancels and a remount sees saving until cleanup releases it.
    const cleanup = claimLiveRecordingFinalization('recording:a');
    expect(cleanup?.cancelled).toBe(true);
    expect(currentLiveRecording()?.phase).toBe('flushing');
    expect(claimLiveRecordingFinalization('recording:a')).toBeNull();
    expect(releaseLiveRecording('recording:a')).toBe(true);
    expect(releaseLiveRecording('recording:a')).toBe(false);
    expect(phases).toEqual(['requesting', 'countdown', 'countdown', 'flushing', null]);
    unsubscribe();
  });

  it('reopens only the failed finalizer so retry can claim once and release', () => {
    const live = liveFor('recording:a');
    expect(tryAdoptLiveRecording(live)).toBe(true);
    expect(claimLiveRecordingFinalization('recording:a')).not.toBeNull();
    expect(currentLiveRecording()?.session.recordedFileId).toBe(live.session.recordedFileId);
    expect(reopenLiveRecordingFinalization('recording:a')).toBe(true);
    expect(currentLiveRecording()).toMatchObject({ finalizing: false, phase: 'recoverable-error' });
    expect(reopenLiveRecordingFinalization('recording:a')).toBe(false);

    // Retry wins exactly one fresh claim; the original late cleanup cannot win it.
    expect(claimLiveRecordingFinalization('recording:a')).not.toBeNull();
    expect(claimLiveRecordingFinalization('recording:a')).toBeNull();
    expect(releaseLiveRecording('recording:a')).toBe(true);
    expect(currentLiveRecording()).toBeNull();
  });

  it('arbitrates competing stop triggers in the module owner', () => {
    expect(tryAdoptLiveRecording(liveFor('recording:race'))).toBe(true);
    const first = claimLiveRecordingStop('recording:race', {
      reasonRef: 'reason:manual', sourceRef: 'control:stop', observedAtMs: 10,
    });
    const late = claimLiveRecordingStop('recording:race', {
      reasonRef: 'reason:silence', sourceRef: 'sensor:rms', observedAtMs: 10,
    });
    expect(first).toMatchObject({ accepted: true, invokeProviderStop: true });
    expect(late).toMatchObject({ accepted: false, invokeProviderStop: false });
    expect(currentLiveRecording()).toMatchObject({
      phase: 'stopping', completion: { reasonRef: 'reason:manual' }, providerStopInvoked: true,
    });
    releaseLiveRecording('recording:race');
  });

  it('keeps a permanent missing chunk terminal instead of advertising a retry', () => {
    const live = liveFor('recording:missing-chunk');
    live.session.chunkFailures.set(3, 'storage exhausted');
    expect(tryAdoptLiveRecording(live)).toBe(true);
    expect(updateLiveRecording(live.session.recordingId, (recording) => {
      recording.finalizing = false;
      recording.phase = recording.session.chunkFailures.size > 0 ? 'terminal-error' : 'recoverable-error';
    })).toBe(true);
    expect(currentLiveRecording()).toMatchObject({ phase: 'terminal-error', finalizing: false });
    releaseLiveRecording(live.session.recordingId);
  });
});
