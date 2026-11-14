import type { LocalPlaybackChunkRef } from '../do-work/recorded-file-store';
import type { CaptureDescriptorValue } from '../do-work/record-audio-requests';
import {
  claimStop,
  type RecordingCompletionObservation,
  type RecordingPhase,
  type RecordingTiming,
} from './recording-lifecycle';

/**
 * The LIVE recording is owned by this module, not by any surface instance.
 * The workspace can mount several tabs of the recording surface and can
 * re-mount surfaces at any time; the in-flight session must outlive every
 * one of them. Panels are views of this store: any instance can render the
 * live session, stop it, or cancel it, and unmounting never kills a live
 * recording.
 */
export type LiveRecordingSession = {
  completionTarget?: import('../../ui/show/placeable-surface-intent/surface-completion-target').PlaceableSurfaceCompletionTarget;
  meetingJoinInvocationId?: string;
  meetingApplicationInputContext?: import('../do-work/meeting-application-recording').MeetingApplicationInputContext;
  meetingEventContext?: import('../do-work/meeting-join-recording').MeetingCalendarContext;
  recordingId: string;
  recordedFileId: string;
  recordedAt: string | null;
  mode: CaptureDescriptorValue;
  mediaType: string;
  startedAtMs: number;
  sequence: number;
  chunkRefs: LocalPlaybackChunkRef[];
  chunkWrites: Promise<LocalPlaybackChunkRef>[];
  chunkResults: Map<number, LocalPlaybackChunkRef>;
  chunkFailures: Map<number, string>;
  journalRevision: number;
  ownerInstanceRef: string;
  journalLeaseMs: number;
  timing: RecordingTiming;
};

export type LiveRecordingPhase = RecordingPhase;

export type LiveRecording = {
  session: LiveRecordingSession;
  recorder: MediaRecorder | null;
  stream: MediaStream | null;
  cancelled: boolean;
  finalizing: boolean;
  phase: LiveRecordingPhase;
  completion: RecordingCompletionObservation | null;
  providerStopInvoked: boolean;
  /** Cancels hardware opening independently of pending owner/permission reads. */
  captureAbortController?: AbortController;
};

let liveRecording: LiveRecording | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Atomic owner-level stop gate shared by every UI/provider trigger. */
export function claimLiveRecordingStop(
  recordingId: string,
  completion: RecordingCompletionObservation,
): { accepted: boolean; invokeProviderStop: boolean; recording: LiveRecording | null } {
  if (liveRecording?.session.recordingId !== recordingId) {
    return { accepted: false, invokeProviderStop: false, recording: null };
  }
  const claim = claimStop({
    phase: liveRecording.phase,
    completion: liveRecording.completion,
    providerStopInvoked: liveRecording.providerStopInvoked,
  }, completion);
  if (claim.accepted) {
    liveRecording.phase = claim.state.phase;
    liveRecording.completion = claim.state.completion;
    liveRecording.providerStopInvoked = claim.state.providerStopInvoked;
    notify();
  }
  return { accepted: claim.accepted, invokeProviderStop: claim.invokeProviderStop, recording: liveRecording };
}

export function currentLiveRecording(): LiveRecording | null {
  return liveRecording;
}

export function tryAdoptLiveRecording(next: LiveRecording): boolean {
  if (liveRecording) return false;
  liveRecording = next;
  notify();
  return true;
}

export function updateLiveRecording(
  recordingId: string,
  update: (recording: LiveRecording) => void,
): boolean {
  if (liveRecording?.session.recordingId !== recordingId) return false;
  update(liveRecording);
  notify();
  return true;
}

/**
 * The browser can report stop after cancellation, unmount, or a new panel has
 * mounted. Only the first matching caller may enter cleanup for this session.
 */
export function claimLiveRecordingFinalization(recordingId: string): LiveRecording | null {
  if (liveRecording?.session.recordingId !== recordingId || liveRecording.finalizing) return null;
  liveRecording.finalizing = true;
  liveRecording.phase = 'flushing';
  notify();
  return liveRecording;
}

/** A failed save keeps this exact recording available for a single retry. */
export function reopenLiveRecordingFinalization(recordingId: string): boolean {
  if (liveRecording?.session.recordingId !== recordingId || !liveRecording.finalizing) return false;
  liveRecording.finalizing = false;
  liveRecording.phase = 'recoverable-error';
  notify();
  return true;
}

/** Id-guarded release: a late finish of a superseded session can never clear
 * a newer live recording. */
export function releaseLiveRecording(recordingId: string): boolean {
  if (liveRecording?.session.recordingId !== recordingId) return false;
  liveRecording = null;
  notify();
  return true;
}

export function subscribeToLiveRecording(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
