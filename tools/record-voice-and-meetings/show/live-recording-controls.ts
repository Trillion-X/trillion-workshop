// parts/record-audio/show/live-recording-controls.ts
//
// PURPOSE
//   What a person can do to the recording in progress from anywhere: pause it, resume it, stop it, change its microphone
//   while it records. The recording is owned
//   by live-recording.ts, not by a screen, so the Record audio screen, the floating "Recording ongoing" card and the
//   microphone pill all press these same functions on it, and the capture journal that lets a closed page recover a
//   recording is written the same way whichever of them pressed.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here belongs to a screen: it reads and changes only the live recording (`currentLiveRecording`).
//   2. A stop is claimed through the live recording's one stop gate (`claimLiveRecordingStop`), so two controls pressing
//      Stop at once stop the recording once.
//   3. Every change of phase is journalled (`writeCaptureJournal`) after it is made, so a page closed at any point leaves
//      the phase the person last saw.
//   4. A microphone is changed only on a recording whose stream can change it (record-in-the-browser.ts invariant 9), so the
//      one recording goes on with no gap; a recording that cannot is answered as such, never restarted.

import { saveRecordingState } from '../do-work/record-audio-requests';
import { writeCaptureJournal } from '../do-work/recorded-file-store';
import type { MicrophoneSwitch, SwitchingStream } from './record-in-the-browser';
import {
  claimLiveRecordingStop,
  currentLiveRecording,
  updateLiveRecording,
  type LiveRecording,
} from './live-recording';
import { activeDurationMs, pauseActiveTime, resumeActiveTime } from './recording-lifecycle';

/** The journal row of a live recording in `phase`; each call is the next revision. */
export function captureJournal(live: LiveRecording, phase = live.phase) {
  live.session.journalRevision += 1;
  const updatedAtMs = Date.now();
  return {
    recording_id: live.session.recordingId,
    ...(live.session.meetingJoinInvocationId ? { meeting_join_invocation_id: live.session.meetingJoinInvocationId } : {}),
    ...(live.session.meetingEventContext ? { meeting_event_context: live.session.meetingEventContext } : {}),
    ...(live.session.meetingApplicationInputContext ? { meeting_application_input_context: live.session.meetingApplicationInputContext } : {}),
    recorded_file_id: live.session.recordedFileId,
    recorded_at: live.session.recordedAt,
    surface_completion_target: live.session.completionTarget,
    phase,
    capture_kind: live.session.mode,
    media_type: live.session.mediaType,
    completion_reason_ref: live.completion?.reasonRef ?? null,
    completion_source_ref: live.completion?.sourceRef ?? null,
    completion_observed_at: live.completion ? new Date(live.completion.observedAtMs).toISOString() : null,
    active_duration_ms: activeDurationMs(live.session.timing, Date.now()),
    expected_sequences: Array.from({ length: live.session.sequence }, (_, index) => index),
    stored_sequences: [...live.session.chunkResults.keys()].sort((left, right) => left - right),
    failed_sequences: [...live.session.chunkFailures.keys()].sort((left, right) => left - right),
    owner_instance_ref: live.session.ownerInstanceRef,
    owner_lease_expires_at: new Date(updatedAtMs + live.session.journalLeaseMs).toISOString(),
    journal_revision: live.session.journalRevision,
    updated_at: new Date(updatedAtMs).toISOString(),
  };
}

type Clock = () => Date;
const wall: Clock = () => new Date();

/** Pauses the recording in progress; answers whether there was one recording to pause. A failed state write is handed to `failed`. */
export function pauseLiveRecording(failed: (error: unknown, live: LiveRecording) => void, now: Clock = wall): boolean {
  const live = currentLiveRecording();
  const recorder = live?.recorder ?? null;
  if (!live || !recorder || recorder.state !== 'recording') return false;
  recorder.pause();
  updateLiveRecording(live.session.recordingId, (recording) => {
    recording.phase = 'paused';
    recording.session.timing = pauseActiveTime(recording.session.timing, Date.now());
  });
  void saveRecordingState({ recordingId: live.session.recordingId, mode: live.session.mode, state: 'paused', observedAt: now().toISOString() })
    .then(() => writeCaptureJournal(captureJournal(live, 'paused')))
    .catch((error: unknown) => failed(error, live));
  return true;
}

/** Resumes a paused recording; answers whether there was one. */
export function resumeLiveRecording(failed: (error: unknown, live: LiveRecording) => void, now: Clock = wall): boolean {
  const live = currentLiveRecording();
  const recorder = live?.recorder ?? null;
  if (!live || !recorder || recorder.state !== 'paused') return false;
  recorder.resume();
  updateLiveRecording(live.session.recordingId, (recording) => {
    recording.phase = 'recording';
    recording.session.timing = resumeActiveTime(recording.session.timing, Date.now());
  });
  void saveRecordingState({ recordingId: live.session.recordingId, mode: live.session.mode, state: 'resumed', observedAt: now().toISOString() })
    .then(() => writeCaptureJournal(captureJournal(live, 'recording')))
    .catch((error: unknown) => failed(error, live));
  return true;
}

/** What stopping the recording came to: whether this call stopped it, and the journal's failure when it could not be written. */
export type StopResult = { stopped: boolean; journalError: unknown | null };

/** Stops the recording in progress for `reasonRef` (said by `sourceRef`). A second stop of the same recording is `stopped: false`. */
export async function stopLiveRecording(reasonRef: string, sourceRef: string): Promise<StopResult> {
  const live = currentLiveRecording();
  if (!live) return { stopped: false, journalError: null };
  const recorder = live.recorder;
  const claim = claimLiveRecordingStop(live.session.recordingId, { reasonRef, sourceRef, observedAtMs: Date.now() });
  if (!claim.invokeProviderStop || !claim.recording) return { stopped: false, journalError: null };
  const journalWrite = writeCaptureJournal(captureJournal(claim.recording, 'stopping'));
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  try {
    await journalWrite;
  } catch (error) {
    return { stopped: true, journalError: error };
  }
  return { stopped: true, journalError: null };
}

/** The microphone of the recording in progress, which the person can change while it records; null when nothing records
 *  or its stream cannot change microphone (then a chosen microphone is for the next recording). */
export function liveRecordingMicrophone(): MicrophoneSwitch | null {
  const live = currentLiveRecording();
  if (!live || live.cancelled || (live.phase !== 'recording' && live.phase !== 'paused')) return null;
  return (live.stream as SwitchingStream | null)?.microphone ?? null;
}

/** Feeds the microphone `deviceId` ('' for the default one) into the recording in progress in place of the one in use;
 *  answers whether there was a recording that could change it. A microphone that cannot be opened is handed to `failed`
 *  and the recording goes on with the one it had. */
export function switchLiveRecordingMicrophone(deviceId: string, failed: (error: unknown) => void): boolean {
  const microphone = liveRecordingMicrophone();
  if (!microphone) return false;
  void microphone.switchTo(deviceId).catch(failed);
  return true;
}
