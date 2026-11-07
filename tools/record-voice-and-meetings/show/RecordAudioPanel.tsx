//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Capture audio, then show the recording library through shared RecordViews.
// This panel owns the in-flight capture session and save workflow. The
// recording package keeps the collection's presentation DATA and adapts its
// existing Visual Database descriptors and recording owner into that shared
// surface; file opening still resolves through the workspace's recording
// owner.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { completeRecordedEvidence } from '../do-work/evidence-completion';
import { keptAccount } from '../../ui/show/page-storage/page-storage';
import { unfinishedJournalsOf } from '../do-work/recording-on-device';
import { readPlaceableSurfaceCompletionTarget } from '../../ui/show/placeable-surface-intent/surface-completion-target';
import {
  useBitfieldData,
} from '#workspace-records';

import {
  beginRecordingNote,
  createRecordAudioId,
  removeRecording,
  saveRecordedFile,
  saveRecordingError,
  saveRecordingState,
  type CaptureDescriptorValue,
} from '../do-work/record-audio-requests';
import {
  saveRecordedFileArtifact,
} from '../do-work/recorded-file-artifact';
import {
  readRecordedFileBlob,
  storedRecordedFileRef,
  storeRecordingChunk,
  storeRecordingChunkWithRetry,
  captureJournalRecoveryState,
  claimMeetingJoinRecordingInvocation,
  writeCaptureJournal,
  listCaptureJournals,
  deleteCaptureJournal,
} from '../do-work/recorded-file-store';
import {
  currentLiveRecording,
  claimLiveRecordingStop,
  claimLiveRecordingFinalization,
  releaseLiveRecording,
  reopenLiveRecordingFinalization,
  subscribeToLiveRecording,
  tryAdoptLiveRecording,
  updateLiveRecording,
  type LiveRecording,
  type LiveRecordingSession,
} from './live-recording';
import {
  activeDurationMs,
  beginActiveTime,
} from './recording-lifecycle';
import {
  decodeRecordAudioCapturePolicy,
  decideMeetingCaptureStart,
  RECORD_AUDIO_CAPTURE_POLICY_INPUT,
  type MeetingCaptureStartMode,
  type MeetingCaptureStartPolicy,
} from '../read-data/capture-policy';
import { isCurrentMeetingApplicationRecordingInvocation, readMeetingApplicationInputContext, type MeetingApplicationRecordingInvocation } from '../do-work/meeting-application-recording';
import { captureSource, canCapture, openSource, openSwitchableMicrophone, awaitCaptureOperation } from './record-in-the-browser';
import meetingSettings from '../read-data/meeting-start-settings.json';
import {
  isFreshMeetingJoinRecordingInvocation,
  readMeetingCalendarContext,
  type MeetingJoinRecordingInvocation,
} from '../do-work/meeting-join-recording';
import type { LocalChosenFile } from '../../local-files/do-work/choose-local-files';
import { FilePicker } from '../../ui/show/folder-picker/FolderPicker';
import {
  recordAudioCapabilityPermission,
  mediaCaptureAvailability,
  mediaStreamForMode,
} from './browser-media-capture';
import { CapabilityPermissionPrompt } from '../../permission-lease/show/CapabilityPermissionPrompt';
import {
  CapabilityPermissionUnavailableError,
  isCapabilityPermissionDenied,
  type CapabilityPermissionState,
} from '../../permission-lease/read-data/capability-permission';
import {
  Button,
  Container,
  ErrorBoundary,
  RecordingBar,
  LiveWaveform,
  ToastProvider,
  Text,
  sanitizeErrorText,
} from '../../ui';
import { noteTitle } from './recording-notices';
import { captureJournal, pauseLiveRecording, resumeLiveRecording, stopLiveRecording } from './live-recording-controls';
import { RecordingLibrary, type RecordingLibraryConfiguration } from './RecordingLibrary';
import { ArrangedContents } from '../../screen-arrangement/show/ArrangedContents';
import recordingLibraryLayout from '../read-data/recording-library.json';
import { selectDescriptorAuthority } from '../../keep-lists-of-rows/do-work/migrate-descriptor-aggregates';
import { foldAddressedDescriptorFactsFromPublishedFeed } from '../../visual-database/read-data/addressed-descriptors';
import { visualDatabaseInputsFromAddressedDescriptors } from '../../visual-database/read-data/descriptor-projection';
import { decodeVisualDatabaseModel } from '../../visual-database/read-data/visual-database';
import { useAddressedCellExpressionOwner } from '../../visual-database/show/use-addressed-cell-expression-owner';

import { errorWords } from '../../ui/show/safe-error-card/sanitize-error-text';
function RecordingBoard({ onOpenRecording, configuration, initialConfigurationId, ruleOperators, loadFilterRecords }: {
  onOpenRecording?: (recordingId: string) => void;
  configuration?: RecordingLibraryConfiguration;
  initialConfigurationId?: string;
  ruleOperators?: React.ComponentProps<typeof RecordingLibrary>['ruleOperators'];
  loadFilterRecords?: React.ComponentProps<typeof RecordingLibrary>['loadFilterRecords'];
}) {
  const records = useBitfieldData('recordAudioRecordings');
  const cellExpressionRecords = useBitfieldData('cellExpressionRecords');
  const evaluatorDescriptors = useBitfieldData('evaluatorDescriptors');
  const descriptorRecords = useBitfieldData('descriptorRecords');
  const descriptorAuthority = useBitfieldData('descriptorAuthority');
  const fold = React.useMemo(() => foldAddressedDescriptorFactsFromPublishedFeed({
    addressPrefix: 'visual-database.descriptors::record-audio',
    pathLabels: ['current-item', 'visual-database-descriptor', 'owner', 'record-audio'],
  }, descriptorRecords), [descriptorRecords]);
  const authority = React.useMemo(() => selectDescriptorAuthority({
    activation: descriptorAuthority,
    target: {
      addressPrefix: 'visual-database.descriptors::record-audio',
      pathLabels: ['current-item', 'visual-database-descriptor', 'owner', 'record-audio'],
    },
    fold,
  }), [descriptorAuthority, fold]);
  const addressed = React.useMemo(() => authority.state === 'addressed'
    ? visualDatabaseInputsFromAddressedDescriptors(authority.snapshots) : null, [authority]);
  const model = React.useMemo(() => decodeVisualDatabaseModel({
    records: authority.state === 'invalid' ? {rows: []} : records,
    fields: addressed?.fields ?? (authority.state === 'invalid' ? {descriptors: []} : undefined),
    views: addressed?.views ?? (authority.state === 'invalid' ? {views: [], palette: []} : undefined),
    actions: authority.state === 'invalid' ? {actions: []} : undefined,
    gridProperties: addressed?.gridProperties ?? (authority.state === 'invalid' ? [] : undefined),
  }), [records, addressed, authority.state]);
  const expressionOwner = useAddressedCellExpressionOwner(cellExpressionRecords, evaluatorDescriptors, model);

  return (
    <RecordingLibrary
      model={model}
      cellExpressionInputs={expressionOwner.cellExpressionInputs}
      evaluatorDescriptors={expressionOwner.evaluatorDescriptors}
      dispatchDerived={expressionOwner.dispatchDerived}
      derivedReadProjection={expressionOwner.derivedReadProjection}
      onOpenRecording={onOpenRecording}
      ruleOperators={ruleOperators}
      loadFilterRecords={loadFilterRecords}
      descriptorAuthorityError={authority.state === 'invalid'
        ? `Saved recording setup failed verification (${authority.reason}).` : undefined}
      configuration={configuration}
      initialConfigurationId={initialConfigurationId}
    />
  );
}

type RecordingStage = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopping' | 'flushing'
  | 'saving' | 'saved' | 'cancelled' | 'interrupted' | 'recoverable-error' | 'terminal-error';

type RecordingSession = LiveRecordingSession;

type RecordAudioPanelProps = {
  now?: () => Date;
  completionTarget?: unknown;
  onOpenRecording?: (recordingId: string) => void;
  recordingLibraryConfiguration?: RecordingLibraryConfiguration;
  recordingLibraryConfigurationId?: string;
  recordingLibraryRuleOperators?: React.ComponentProps<typeof RecordingLibrary>['ruleOperators'];
  recordingLibraryLoadFilterRecords?: React.ComponentProps<typeof RecordingLibrary>['loadFilterRecords'];
  meetingStartMode?: MeetingCaptureStartMode;
  meetingStartPolicy?: MeetingCaptureStartPolicy;
  readMeetingStartPolicy?: () => MeetingCaptureStartPolicy | Promise<MeetingCaptureStartPolicy>;
  meetingJoinRecording?: unknown;
  meetingRecordingInvocation?: unknown;
  /** An explicit reminder action; reminder mode alone never starts capture. */
  recordingRequested?: boolean;
  /** Inert context from an explicit Record-on-event entry; it never starts capture. */
  meetingEventContext?: unknown;
  meetingContextLabel?: string;
  /** The microphone the next recording opens ('' or absent: the default one). */
  microphone?: () => string;
  /** Told once a recording is kept, with its span and whether it belongs to a calendar event. */
  onRecordingSaved?: (saved: RecordingSavedFact) => void;
};

export type RecordingSavedFact = { recordingId: string; label: string; startedAt: string; endedAt: string; hasMeetingEvent: boolean };

const defaultNow = () => new Date();
type MeetingRecordingInvocation = MeetingJoinRecordingInvocation | MeetingApplicationRecordingInvocation;
class MeetingRecordingEndedError extends Error {}
function currentMeetingInvocation(value: unknown): value is MeetingRecordingInvocation {
  return isFreshMeetingJoinRecordingInvocation(value) || isCurrentMeetingApplicationRecordingInvocation(value);
}

const RECORD_AUDIO_EXTENSIONS = [
  'aac',
  'aif',
  'aiff',
  'flac',
  'm4a',
  'mp3',
  'ogg',
  'wav',
  'webm',
];

function mediaRecorderConstructor(): typeof MediaRecorder | null {
  return typeof MediaRecorder === 'undefined' ? null : MediaRecorder;
}

function mediaTypeForRecorder(mode: CaptureDescriptorValue): string {
  const Constructor = mediaRecorderConstructor();
  const candidates = mode === 'video'
    ? [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4',
    ]
    : [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/aac',
    ];
  return candidates.find((candidate) => Constructor?.isTypeSupported(candidate)) ?? '';
}

function defaultRecordingLabel(mode: CaptureDescriptorValue, at: Date): string {
  const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at);
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
  return `${mode === 'video' ? 'Video' : 'Recording'} ${day} ${time}`;
}

function plainError(error: unknown): string {
  return errorWords(error, 'Recording could not be completed.');
}

type CompletionReasonRefs = {
  manual: string;
  providerEnd: string;
  providerError: string;
  cancel: string;
};

function decodeCompletionReasonRefs(value: unknown): CompletionReasonRefs {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const read = (keys: string[], fallback: string) => {
    for (const key of keys) {
      if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
    }
    return fallback;
  };
  return {
    manual: read(['manual'], 'capture-completion:operator-stop'),
    providerEnd: read(['provider_end', 'providerEnd'], 'capture-completion:provider-ended'),
    providerError: read(['provider_error', 'providerError'], 'capture-completion:provider-error'),
    cancel: read(['cancel'], 'capture-completion:operator-cancel'),
  };
}

function diagnosticErrorDetail(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function recordingEnvironment(): string {
  const parts = [
    `url=${typeof window === 'undefined' ? 'unavailable' : window.location.href}`,
    `secureContext=${typeof window !== 'undefined' && window.isSecureContext ? 'yes' : 'no'}`,
    `userAgent=${typeof navigator === 'undefined' ? 'unavailable' : navigator.userAgent}`,
    mediaCaptureAvailability(),
    `MediaRecorder=${mediaRecorderConstructor() ? 'available' : 'missing'}`,
  ];
  return parts.join(' | ');
}

function pickedFileDetail(file: LocalChosenFile): string {
  return `${file.name} (${file.contentType || 'unknown type'}, ${file.byteLength} bytes, ${file.path})`;
}

function modeForLocalFile(file: LocalChosenFile): CaptureDescriptorValue {
  return file.contentType.startsWith('video/') ? 'video' : 'audio';
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export function RecordAudioPanel({
  now = defaultNow,
  completionTarget,
  onOpenRecording,
  recordingLibraryConfiguration,
  recordingLibraryConfigurationId,
  recordingLibraryRuleOperators,
  recordingLibraryLoadFilterRecords,
  meetingStartMode = 'manual',
  meetingStartPolicy,
  readMeetingStartPolicy,
  meetingJoinRecording,
  meetingRecordingInvocation,
  recordingRequested = false,
  meetingEventContext,
  meetingContextLabel,
  microphone,
  onRecordingSaved,
}: RecordAudioPanelProps) {
  const [stage, setStage] = React.useState<RecordingStage>('idle');
  const [fileStatus, setFileStatus] = React.useState<'idle' | 'picking' | 'saving'>('idle');
  const [mode, setMode] = React.useState<CaptureDescriptorValue>('audio');
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const [message, setMessage] = React.useState('');
  const [permissionState, setPermissionState] = React.useState<Exclude<CapabilityPermissionState, 'granted'> | null>(null);
  const [recoveryScanNonce, setRecoveryScanNonce] = React.useState(0);
  const consumedMeetingJoin = React.useRef<string | null>(null);
  // Async storage and permission callbacks recheck the latest policy, not the
  // render that began the request. A changed or expired trigger cannot capture.
  const meetingPolicy = React.useRef<MeetingCaptureStartPolicy>({ mode: 'manual', allowedApps: [], blockedApps: [] });
  meetingPolicy.current = meetingStartPolicy ?? { mode: meetingStartMode, allowedApps: [], blockedApps: [] };
  const readMeetingPolicy = React.useRef(readMeetingStartPolicy);
  readMeetingPolicy.current = readMeetingStartPolicy;
  const recordingSaved = React.useRef(onRecordingSaved);
  recordingSaved.current = onRecordingSaved;
  const completionReasonRefsValue = useBitfieldData('recordAudioCompletionReasonRefs');
  const capturePolicyValue = useBitfieldData(RECORD_AUDIO_CAPTURE_POLICY_INPUT);
  const completionReasonRefs = React.useMemo(
    () => decodeCompletionReasonRefs(completionReasonRefsValue),
    [completionReasonRefsValue],
  );
  const capturePolicy = React.useMemo(
    () => decodeRecordAudioCapturePolicy(capturePolicyValue),
    [capturePolicyValue],
  );

  const recordDiagnostic = React.useCallback((event: string, detail: string) => {
    console.info(`[record-audio] ${event}`, detail);
  }, []);

  React.useEffect(() => {
    recordDiagnostic('recording surface ready', recordingEnvironment());
  }, [recordDiagnostic]);

  React.useEffect(() => {
    let cancelled = false;
    let recoveryTimer: number | null = null;
    void listCaptureJournals().then(async (journals) => {
      // Only this signed-in account's unfinished recordings are recovered here; another account's, and any that name no
      // account, are left as they are (nothing is rewritten for someone else), and nothing is recovered with no account.
      const incomplete = unfinishedJournalsOf(journals, keptAccount()?.store ?? null);
      if (cancelled || incomplete.length === 0) return;
      let interruptedCount = 0;
      let earliestLeaseExpiry = Number.POSITIVE_INFINITY;
      for (const journal of incomplete) {
        const current = currentLiveRecording();
        const recoveryState = captureJournalRecoveryState(
          journal,
          current?.session.recordingId ?? null,
          now().getTime(),
        );
        if (recoveryState === 'owned-here') continue;
        const leaseExpiresAt = Date.parse(journal.owner_lease_expires_at ?? '');
        if (recoveryState === 'leased-elsewhere') {
          earliestLeaseExpiry = Math.min(earliestLeaseExpiry, leaseExpiresAt);
          continue;
        }
        if (journal.phase !== 'interrupted') {
          const observedAt = now().toISOString();
          await writeCaptureJournal({
            ...journal,
            completion_source_ref: journal.completion_source_ref ?? null,
            completion_observed_at: journal.completion_observed_at ?? null,
            stored_sequences: journal.stored_sequences ?? [],
            owner_instance_ref: journal.owner_instance_ref ?? 'capture-owner:legacy',
            owner_lease_expires_at: observedAt,
            journal_revision: (journal.journal_revision ?? 0) + 1,
            phase: 'interrupted',
            updated_at: observedAt,
          });
          await saveRecordingState({
            recordingId: journal.recording_id,
            mode: journal.capture_kind,
            state: 'interrupted',
            observedAt,
            completionReason: journal.completion_reason_ref ?? undefined,
          });
          interruptedCount += 1;
        }
      }
      if (!cancelled && Number.isFinite(earliestLeaseExpiry)) {
        recoveryTimer = window.setTimeout(
          () => setRecoveryScanNonce((value) => value + 1),
          Math.max(1, earliestLeaseExpiry - now().getTime() + 1),
        );
      }
      if (!cancelled && interruptedCount > 0) {
        setMessage(`${interruptedCount} interrupted capture${interruptedCount === 1 ? '' : 's'} found. Saved chunks were preserved; no successful recording was fabricated.`);
      }
    }).catch((error: unknown) => {
      if (!cancelled) setMessage(`Capture recovery check failed: ${plainError(error)}`);
    });
    return () => {
      cancelled = true;
      if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
    };
  }, [now, recoveryScanNonce]);

  React.useEffect(() => {
    if (stage !== 'recording') return undefined;
    const timer = window.setInterval(() => {
      const timing = currentLiveRecording()?.session.timing;
      setElapsedMs(timing ? activeDurationMs(timing, Date.now()) : 0);
    }, 250);
    return () => window.clearInterval(timer);
  }, [stage]);

  // The live recording is module-owned. Every surface instance renders it,
  // and a remount adopts the in-flight session instead of losing it.
  const [liveVersion, setLiveVersion] = React.useState(0);
  React.useEffect(() => subscribeToLiveRecording(() => setLiveVersion((current) => current + 1)), []);
  React.useEffect(() => {
    const active = currentLiveRecording();
    if (!active) {
      // Finished/cancelled in another tab while this view showed it.
      setStage((current) => (
        current === 'recording' || current === 'paused' || current === 'requesting' || current === 'saving'
          ? 'idle'
          : current
      ));
      setElapsedMs(0);
      return;
    }
    setMode(active.session.mode);
    setStage(active.phase);
    setElapsedMs(activeDurationMs(active.session.timing, Date.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveVersion]);

  React.useEffect(() => () => {
    // Unmount detaches THIS view only. The module-owned live recording,
    // its recorder, and stream keep running; any other instance (or a
    // remount of this one) can still stop and save it.
  }, []);

  React.useEffect(() => {
    const active = currentLiveRecording();
    if (!active || ['saved', 'cancelled', 'terminal-error'].includes(active.phase)) return undefined;
    const timer = window.setInterval(() => {
      const current = currentLiveRecording();
      if (!current || ['saved', 'cancelled', 'terminal-error'].includes(current.phase)) return;
      void writeCaptureJournal(captureJournal(current, current.phase));
    }, capturePolicy.journalHeartbeatMs);
    return () => window.clearInterval(timer);
  }, [capturePolicy.journalHeartbeatMs, liveVersion]);

  const recordError = React.useCallback(async (recordingId: string, nextMode: CaptureDescriptorValue, error: unknown) => {
    const nextMessage = plainError(error);
    const active = currentLiveRecording();
    const permanentChunkLoss = active?.session.recordingId === recordingId
      && active.session.chunkFailures.size > 0;
    const reopened = !permanentChunkLoss && reopenLiveRecordingFinalization(recordingId);
    if (!reopened) {
      updateLiveRecording(recordingId, (recording) => {
        recording.finalizing = false;
        recording.phase = permanentChunkLoss ? 'terminal-error' : 'recoverable-error';
      });
    }
    recordDiagnostic('recording error', diagnosticErrorDetail(error));
    setMessage(nextMessage);
    setStage(permanentChunkLoss ? 'terminal-error' : 'recoverable-error');
    await saveRecordingError({
      recordingId,
      mode: nextMode,
      message: nextMessage,
      observedAt: now().toISOString(),
    });
    if (active?.session.recordingId === recordingId) {
      await saveRecordingState({
        recordingId,
        mode: nextMode,
        state: permanentChunkLoss ? 'terminal-error' : 'recoverable-error',
        observedAt: now().toISOString(),
        completionReason: active.completion?.reasonRef,
      });
      await writeCaptureJournal(captureJournal(active, permanentChunkLoss ? 'terminal-error' : 'recoverable-error'));
    }
  }, [now, recordDiagnostic]);

  const stopWithReason = React.useCallback(async (reasonRef: string, sourceRef: string) => {
    const result = await stopLiveRecording(reasonRef, sourceRef);
    if (result.stopped) setStage('stopping');
    if (result.journalError) setMessage(`Recording stopped, but its recovery journal could not be updated: ${plainError(result.journalError)}`);
  }, []);

  const finishSession = React.useCallback(async (recordingId: string) => {
    const live = claimLiveRecordingFinalization(recordingId);
    if (!live) return;
    const session = live.session;
    await writeCaptureJournal(captureJournal(live, 'flushing'));
    stopStream(live.stream);
    updateLiveRecording(session.recordingId, (recording) => {
      recording.stream = null;
    });

    if (live.cancelled) {
      await Promise.allSettled(session.chunkWrites);
      await saveRecordingState({
        recordingId: session.recordingId,
        mode: session.mode,
        state: 'cancelled',
        observedAt: now().toISOString(),
      });
      await deleteCaptureJournal(session.recordingId, 'cancelled');
      // The note made when it began goes with it: a cancelled recording leaves nothing in the library.
      await removeRecording({ recordedFileId: session.recordedFileId }).catch((error: unknown) => recordDiagnostic('cancelled note removal error', diagnosticErrorDetail(error)));
      releaseLiveRecording(session.recordingId);
      setStage('idle');
      setElapsedMs(0);
      setMessage('');
      return;
    }

    setStage('saving');
    updateLiveRecording(session.recordingId, (recording) => { recording.phase = 'saving'; });
    await writeCaptureJournal(captureJournal(live, 'saving'));
    await Promise.allSettled(session.chunkWrites);
    if (session.chunkFailures.size > 0) {
      throw new Error(`Recording has permanently unsaved chunk sequences: ${[...session.chunkFailures.keys()].sort((a, b) => a - b).join(', ')}.`);
    }
    if (session.chunkRefs.length === 0) {
      throw new Error('Recording stopped before anything was saved.');
    }

    session.recordedAt ??= live.completion
      ? new Date(live.completion.observedAtMs).toISOString()
      : now().toISOString();
    const recordedAt = session.recordedAt;
    const recordedAtDate = new Date(recordedAt);
    const durationMs = activeDurationMs(session.timing, Date.now());
    const recordedFileId = session.recordedFileId;
    const storedFileRef = storedRecordedFileRef({
      recordingId: session.recordingId,
      recordedFileId,
      recordedAt,
      mediaType: session.mediaType,
      chunkRefs: session.chunkRefs,
    });
    const recordedBlob = await readRecordedFileBlob(storedFileRef);
    const { sourceRef } = await saveRecordedFileArtifact({
      recordingId: session.recordingId,
      recordedFileId,
      mode: session.mode,
      mediaType: session.mediaType,
      recordedAt,
      bytes: await blobBytes(recordedBlob),
    });

    await saveRecordingState({
      recordingId: session.recordingId,
      mode: session.mode,
      state: 'stopped',
      observedAt: recordedAt,
      completionReason: live.completion?.reasonRef ?? completionReasonRefs.providerEnd,
    });
    await saveRecordedFile({
      recordingId: session.recordingId,
      label: defaultRecordingLabel(session.mode, recordedAtDate),
      recordedFileId,
      mode: session.mode,
      mediaType: session.mediaType,
      byteLength: storedFileRef.byte_length,
      durationMs,
      recordedAt,
      storedFileRef,
      sourceRef,
      completionReasonRef: live.completion?.reasonRef ?? completionReasonRefs.providerEnd,
      completionObservedAt: live.completion ? new Date(live.completion.observedAtMs).toISOString() : recordedAt,
      artifactDisposition: live.completion?.reasonRef === completionReasonRefs.providerError
        ? 'saved-with-capture-error'
        : 'saved',
      ...(session.meetingEventContext ? { meetingEventContext: session.meetingEventContext } : {}),
      ...(session.meetingApplicationInputContext ? { meetingApplicationInputContext: session.meetingApplicationInputContext } : {}),
    });

    if (session.completionTarget) {
      await completeRecordedEvidence({ completionTarget: session.completionTarget, sourceRef, recordedFileId });
    }
    await deleteCaptureJournal(session.recordingId);
    releaseLiveRecording(session.recordingId);
    setStage('idle');
    setMessage('Recording saved.');
    recordingSaved.current?.({
      recordingId: session.recordingId,
      label: defaultRecordingLabel(session.mode, recordedAtDate),
      startedAt: new Date(recordedAtDate.getTime() - durationMs).toISOString(),
      endedAt: recordedAt,
      hasMeetingEvent: Boolean(session.meetingEventContext),
    });
  }, [completionReasonRefs.providerEnd, now, recordDiagnostic]);

  const startRecording = React.useCallback(async (nextMode: CaptureDescriptorValue, meetingInvocation?: MeetingRecordingInvocation, explicitlyRequested = false) => {
    let reservedLive: LiveRecording | null = null;
    const ownsRequest = () => !reservedLive || (!reservedLive.cancelled && currentLiveRecording() === reservedLive);
    const triggerCurrent = async () => {
      if (!meetingInvocation) return ownsRequest();
      if (!ownsRequest() || !currentMeetingInvocation(meetingInvocation)) return false;
      const policy = await awaitCaptureOperation(() => readMeetingPolicy.current?.() ?? meetingPolicy.current,
        reservedLive?.captureAbortController?.signal);
      if (!ownsRequest() || !currentMeetingInvocation(meetingInvocation)) return false;
      const decision = decideMeetingCaptureStart(policy, meetingInvocation);
      return decision === 'start' || (explicitlyRequested && decision === 'remind');
    };
    const Constructor = mediaRecorderConstructor();
    if (currentLiveRecording()) {
      setMessage('A recording is already in progress. Stop it before starting another.');
      return;
    }
    const recordingId = createRecordAudioId('recording');
    setStage('requesting');
    setMode(nextMode);
    setMessage('');
    setPermissionState(null);
    setElapsedMs(0);

    try {
      recordDiagnostic('recording request start', `recordingId=${recordingId} | mode=${nextMode} | ${recordingEnvironment()}`);
      if (!Constructor) throw new Error('This browser cannot record audio here.');
      const requestedMediaType = mediaTypeForRecorder(nextMode);
      const session: RecordingSession = {
        completionTarget: completionTarget == null ? undefined
          : JSON.parse(JSON.stringify(readPlaceableSurfaceCompletionTarget(completionTarget))),
        recordingId,
        recordedFileId: createRecordAudioId('recorded-file'),
        recordedAt: null,
        mode: nextMode,
        mediaType: requestedMediaType || (nextMode === 'video' ? 'video/webm' : 'audio/webm'),
        startedAtMs: 0,
        sequence: 0,
        chunkRefs: [],
        chunkWrites: [],
        chunkResults: new Map(),
        chunkFailures: new Map(),
        journalRevision: 0,
        ownerInstanceRef: `capture-owner:${createRecordAudioId('instance')}`,
        journalLeaseMs: capturePolicy.journalLeaseMs,
        timing: { activeStartedAtMs: null, accumulatedActiveMs: 0 },
      };
      const live: LiveRecording = {
        session,
        recorder: null,
        stream: null,
        cancelled: false,
        finalizing: false,
        phase: 'requesting',
        completion: null,
        providerStopInvoked: false,
        captureAbortController: new AbortController(),
      };

      // Reserve synchronously before the permission await. Otherwise two
      // mounted tabs can both acquire hardware before either becomes owner.
      if (!tryAdoptLiveRecording(live)) {
        setStage('idle');
        setMessage('A recording is already in progress. Stop it before starting another.');
        return;
      }
      reservedLive = live;
      if (!await triggerCurrent()) {
        releaseLiveRecording(recordingId); setStage('idle'); return;
      }
      if (meetingInvocation) {
        const claimed = await claimMeetingJoinRecordingInvocation(
          meetingInvocation.invocationId,
          Date.parse(meetingInvocation.expiresAt),
        );
        if (!claimed || !await triggerCurrent()) {
          releaseLiveRecording(recordingId);
          setStage('idle');
          setMessage('This meeting recording request has ended. You can start a recording manually.');
          return;
        }
        // A native microphone episode does not identify a Calendar event.
        if (meetingInvocation.kind === 'meeting-join-initiated') {
          session.meetingJoinInvocationId = meetingInvocation.invocationId;
          session.meetingEventContext = meetingInvocation.calendarEvent;
        } else session.meetingApplicationInputContext = readMeetingApplicationInputContext(meetingInvocation) ?? undefined;
      } else {
        const context = readMeetingCalendarContext(meetingEventContext);
        if (context) session.meetingEventContext = context;
      }
      await writeCaptureJournal(captureJournal(live, 'requesting'));
      if (live.cancelled || currentLiveRecording() !== live) return;
      if (!await triggerCurrent()) throw new MeetingRecordingEndedError();

      const meetingSource = captureSource(meetingSettings.capture_source);
      const stream = meetingInvocation && meetingSource
        && (meetingInvocation.kind === 'application-input-started' || canCapture(meetingSource))
        ? await openSource(meetingSource, undefined, triggerCurrent, live.captureAbortController?.signal)
        // The person can change this microphone while it records (the pill's microphone menu).
        : await openSwitchableMicrophone(pick => mediaStreamForMode(nextMode, pick), microphone?.() ? { audio: microphone() } : undefined);
      if (live.cancelled || currentLiveRecording() !== live) {
        stopStream(stream);
        return;
      }
      // Retain the acquired stream with its owner before the final recheck so
      // expected trigger expiry also releases hardware in the shared catch.
      live.stream = stream;
      if (!await triggerCurrent()) throw new MeetingRecordingEndedError();
      recordDiagnostic(
        'recording stream granted',
        stream.getTracks().map((track) => `${track.kind}:${track.readyState}:${track.label || 'unlabeled'}`).join(', ') || 'no tracks',
      );
      const recorder = new Constructor(stream, requestedMediaType ? { mimeType: requestedMediaType } : undefined);
      updateLiveRecording(recordingId, (recording) => {
        recording.recorder = recorder;
        recording.stream = stream;
        recording.session.mediaType = recorder.mimeType || recording.session.mediaType;
      });
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          void stopWithReason(completionReasonRefs.providerEnd, `media-track:${track.kind}:ended`);
        }, { once: true });
      }

      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        const activeSession = currentLiveRecording()?.session;
        if (activeSession !== session) return;
        const sequence = activeSession.sequence;
        activeSession.sequence += 1;
        const chunkWrite = storeRecordingChunkWithRetry({
          recordingId: activeSession.recordingId,
          sequence,
          mediaType: activeSession.mediaType,
          chunk: event.data,
          observedAt: now().toISOString(),
        }).then((chunkRef) => {
          activeSession.chunkResults.set(sequence, chunkRef);
          activeSession.chunkRefs = [...activeSession.chunkResults.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, ref]) => ref);
          return chunkRef;
        }).catch((error: unknown) => {
          activeSession.chunkFailures.set(sequence, diagnosticErrorDetail(error));
          throw error;
        });
        activeSession.chunkWrites.push(chunkWrite);
        void chunkWrite.catch(() => {
          void stopWithReason(completionReasonRefs.providerError, `chunk-store:sequence:${sequence}`);
        });
      };
      recorder.onstop = () => {
        const active = currentLiveRecording();
        if (active?.session.recordingId === session.recordingId && !active.completion) {
          claimLiveRecordingStop(session.recordingId, {
            reasonRef: completionReasonRefs.providerEnd,
            sourceRef: 'media-recorder:onstop',
            observedAtMs: Date.now(),
          });
        }
        void finishSession(session.recordingId).catch((error: unknown) => {
          void recordError(session.recordingId, session.mode, error);
        });
      };
      recorder.onerror = () => {
        void stopWithReason(completionReasonRefs.providerError, 'media-recorder:onerror');
      };

      session.startedAtMs = Date.now();
      session.timing = beginActiveTime(session.startedAtMs);
      await saveRecordingState({
        recordingId,
        mode: nextMode,
        state: 'recording',
        observedAt: now().toISOString(),
      });
      if (live.cancelled || currentLiveRecording() !== live) return;
      if (!await triggerCurrent()) throw new MeetingRecordingEndedError();
      recorder.start(1000);
      updateLiveRecording(recordingId, (recording) => {
        recording.phase = 'recording';
      });
      // The meeting note exists from this moment, so it can be written in while the recording goes on.
      void beginRecordingNote({
        recordedFileId: session.recordedFileId,
        label: noteTitle(live),
        mode: nextMode,
        recordedAt: new Date(session.startedAtMs).toISOString(),
        ...(session.meetingEventContext ? { meetingEventContext: session.meetingEventContext } : {}),
        ...(session.meetingApplicationInputContext ? { meetingApplicationInputContext: session.meetingApplicationInputContext } : {}),
      }).catch((error: unknown) => recordDiagnostic('recording note error', diagnosticErrorDetail(error)));
      await writeCaptureJournal(captureJournal(live, 'recording'));
      recordDiagnostic('recording started', `recordingId=${recordingId} | mimeType=${recorder.mimeType || session.mediaType}`);
      setStage('recording');
    } catch (error) {
      const adopted = currentLiveRecording();
      if (adopted && adopted.session.recordingId === recordingId) {
        stopStream(adopted.stream);
        adopted.stream = null;
        releaseLiveRecording(recordingId);
      }
      if (reservedLive?.cancelled || error instanceof MeetingRecordingEndedError || (meetingInvocation && (!currentMeetingInvocation(meetingInvocation)))) {
        try { await deleteCaptureJournal(recordingId, 'cancelled'); }
        catch (cleanupError) { await recordError(recordingId, nextMode, cleanupError); return; }
        setStage('idle');
        setMessage('This meeting recording request has ended. You can start a recording manually.');
        return;
      }
      if (isCapabilityPermissionDenied(error)) {
        recordDiagnostic('recording awaits permission', diagnosticErrorDetail(error));
        setStage('idle');
        setPermissionState('denied-by-system');
        return;
      }
      if (error instanceof CapabilityPermissionUnavailableError) {
        recordDiagnostic('recording permission unavailable', diagnosticErrorDetail(error));
        setStage('idle');
        setPermissionState('platform-unavailable');
        return;
      }
      await recordError(recordingId, nextMode, error);
    }
  }, [completionTarget, meetingEventContext, microphone, capturePolicy.journalLeaseMs, completionReasonRefs.providerEnd, completionReasonRefs.providerError, finishSession, now, recordDiagnostic, recordError, stopWithReason]);

  React.useEffect(() => {
    const invocation = meetingRecordingInvocation ?? meetingJoinRecording;
    if (!currentMeetingInvocation(invocation)) return;
    const decision = decideMeetingCaptureStart(meetingPolicy.current, invocation);
    if (decision !== 'start' && !(recordingRequested && decision === 'remind')) return;
    if (consumedMeetingJoin.current === invocation.invocationId) return;
    consumedMeetingJoin.current = invocation.invocationId;
    void startRecording('audio', invocation, recordingRequested);
  }, [meetingJoinRecording, meetingRecordingInvocation, meetingStartMode, meetingStartPolicy, recordingRequested, startRecording]);

  const stopRecording = React.useCallback(() => {
    void stopWithReason(completionReasonRefs.manual, 'record-audio:stop-control');
  }, [completionReasonRefs.manual, stopWithReason]);

  const pauseRecording = React.useCallback(() => {
    const paused = pauseLiveRecording((error, live) => void recordError(live.session.recordingId, live.session.mode, error), now);
    if (paused) setStage('paused');
  }, [now, recordError]);

  const resumeRecording = React.useCallback(() => {
    const resumed = resumeLiveRecording((error, live) => void recordError(live.session.recordingId, live.session.mode, error), now);
    if (resumed) setStage('recording');
  }, [now, recordError]);

  const cancelRecording = React.useCallback(() => {
    const live = currentLiveRecording();
    if (!live) return;
    if (live.phase === 'requesting' && !live.recorder) {
      live.cancelled = true;
      live.captureAbortController?.abort();
      stopStream(live.stream);
      releaseLiveRecording(live.session.recordingId);
      setStage('idle');
      setElapsedMs(0);
      setMessage('');
      void Promise.all([
        saveRecordingState({
          recordingId: live.session.recordingId,
          mode: live.session.mode,
          state: 'cancelled',
          observedAt: now().toISOString(),
        }),
        deleteCaptureJournal(live.session.recordingId, 'cancelled'),
      ]).catch((error: unknown) => {
        recordDiagnostic('cancelled request cleanup error', diagnosticErrorDetail(error));
      });
      return;
    }
    updateLiveRecording(live.session.recordingId, (recording) => {
      recording.cancelled = true;
    });
    const recorder = live.recorder;
    if (recorder && recorder.state !== 'inactive') {
      void stopWithReason(completionReasonRefs.cancel, 'record-audio:cancel-control');
      return;
    }
    const claim = claimLiveRecordingStop(live.session.recordingId, {
      reasonRef: completionReasonRefs.cancel,
      sourceRef: 'record-audio:cancel-control',
      observedAtMs: Date.now(),
    });
    if (claim.accepted && claim.recording) {
      void writeCaptureJournal(captureJournal(claim.recording, 'stopping'))
        .then(() => finishSession(live.session.recordingId))
        .catch((error: unknown) => void recordError(live.session.recordingId, live.session.mode, error));
    }
  }, [completionReasonRefs.cancel, finishSession, now, recordDiagnostic, recordError, stopWithReason]);

  const savePickedFile = React.useCallback(async (file: LocalChosenFile) => {
    const capturedCompletionTarget = completionTarget == null ? undefined
      : JSON.parse(JSON.stringify(readPlaceableSurfaceCompletionTarget(completionTarget)));
    const importedAtDate = now();
    const importedAt = importedAtDate.toISOString();
    const nextMode = modeForLocalFile(file);
    const recordingId = createRecordAudioId('recording');
    const recordedFileId = createRecordAudioId('recorded-file');
    const mediaType = file.contentType || (nextMode === 'video' ? 'video/mp4' : 'audio/mpeg');
    const fileBlob = new Blob([file.bytes.slice()], { type: mediaType });

    recordDiagnostic('picked file save start', `recordingId=${recordingId} | ${pickedFileDetail(file)}`);
    await saveRecordingState({
      recordingId,
      mode: nextMode,
      state: 'importing',
      observedAt: importedAt,
    });
    const chunkRef = await storeRecordingChunk({
      recordingId,
      sequence: 0,
      mediaType,
      chunk: fileBlob,
      observedAt: importedAt,
    });
    const storedFileRef = storedRecordedFileRef({
      recordingId,
      recordedFileId,
      recordedAt: importedAt,
      mediaType,
      chunkRefs: [chunkRef],
    });
    const { sourceRef } = await saveRecordedFileArtifact({
      recordingId,
      recordedFileId,
      mode: nextMode,
      mediaType,
      displayName: file.name,
      recordedAt: importedAt,
      bytes: file.bytes,
    });

    await saveRecordedFile({
      recordingId,
      label: file.name || defaultRecordingLabel(nextMode, importedAtDate),
      recordedFileId,
      mode: nextMode,
      mediaType,
      byteLength: file.byteLength,
      durationMs: 0,
      recordedAt: importedAt,
      storedFileRef,
      sourceRef,
      artifactDisposition: 'imported',
    });
    await saveRecordingState({
      recordingId,
      mode: nextMode,
      state: 'imported',
      observedAt: now().toISOString(),
    });

    if (capturedCompletionTarget) {
      await completeRecordedEvidence({ completionTarget: capturedCompletionTarget, sourceRef, recordedFileId });
    }
    setMessage(`${file.name} saved.`);
    recordDiagnostic('picked file saved', `recordedFileId=${recordedFileId} | bytes=${file.byteLength}`);
  }, [completionTarget, now, recordDiagnostic]);

  const openFiles = React.useCallback(async (selected: File[]) => {
    if (fileStatus !== 'idle') return;
    if (selected.length === 0) return;
    setFileStatus('saving');
    setMessage('');
    recordDiagnostic('local file picker selected', `${selected.length} browser file(s)`);
    try {
      for (const file of selected) {
        const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
        if (!file.type.startsWith('audio/') && !RECORD_AUDIO_EXTENSIONS.includes(extension)) {
          throw new Error(`${file.name} is not an audio file.`);
        }
        const picked: LocalChosenFile = {
          path: '', name: file.name, byteLength: file.size,
          contentType: file.type || (extension === 'wav' ? 'audio/wav' : 'audio/mpeg'),
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
        await savePickedFile(picked);
      }
    } catch (error) {
      const recordingId = createRecordAudioId('recording');
      const nextMessage = plainError(error);
      recordDiagnostic('picked file error', diagnosticErrorDetail(error));
      setMessage(nextMessage);
      await saveRecordingError({
        recordingId,
        mode,
        message: nextMessage,
        observedAt: now().toISOString(),
      });
    } finally {
      setFileStatus('idle');
    }
  }, [fileStatus, mode, now, recordDiagnostic, savePickedFile]);

  const live = stage === 'recording';
  const paused = stage === 'paused';
  const stopping = stage === 'stopping' || stage === 'flushing';
  const activeCapture = live || paused || stopping;
  const captureBusy = stage === 'requesting' || stage === 'stopping'
    || stage === 'flushing' || stage === 'saving';
  const fileBusy = fileStatus !== 'idle';
  const recoverableError = stage === 'recoverable-error';
  const captureOperations: Record<string, () => unknown> = {cancel: cancelRecording, pause: pauseRecording, resume: resumeRecording, stop: stopRecording};
  const captureActions = recordingLibraryLayout.capture_bar.actions.flatMap(action => {
    if ('when' in action && action.when !== stage) return [];
    const operation = captureOperations[action.operation];
    if (!operation) return [];
    return [{...action, disabled: action.operation !== 'cancel' && stopping, onPress: () => void operation()}];
  });

  const capturePane = (
    <Container layout="vertical" gap="lg" padding="lg" overflow="y-auto" flex={0} className="min-w-0">
      <Container layout="vertical" gap="xs">
        <Text variant="heading-xl" tabular={activeCapture}>
          {stage === 'saving' || fileStatus === 'saving'
              ? 'Saving'
              : 'Record audio'}
        </Text>
        {stage === 'idle' && meetingContextLabel && readMeetingCalendarContext(meetingEventContext)
          ? <Text variant="body" color="subtle">{meetingContextLabel}</Text> : null}
        {paused ? <Text variant="body-xs" color="faint">Paused</Text> : null}
        {stage === 'requesting' ? <Text variant="body-xs" color="faint">Allow access.</Text> : null}
        {recoverableError || stage === 'terminal-error' ? <Text variant="body" color="error">{message}</Text> : null}
      </Container>

      {activeCapture ? <RecordingBar
        stream={currentLiveRecording()?.stream ?? null} active={live} elapsedMs={elapsedMs}
        actions={captureActions} aria-label={recordingLibraryLayout.capture_bar.label}
        waveformLabel={recordingLibraryLayout.capture_bar.waveform_label}
      /> : stage === 'saving' ? (
        <LiveWaveform stream={currentLiveRecording()?.stream ?? null} active={live} processing={stage === 'saving'} frame="flat" edgeFade />
      ) : null}

      <Container layout="horizontal" gap="sm" wrap alignItems="center">
        {!activeCapture ? (
          <>
            {!permissionState ? (
              <Button variant="primary" work={null} loading={stage === 'requesting'} disabled={captureBusy || fileBusy} onClick={() => startRecording('audio')}>
                Start recording
              </Button>
            ) : null}
            <FilePicker label="Pick an audio file" accept="audio/*,.aac,.aif,.aiff,.flac,.m4a,.mp3,.ogg,.wav,.webm"
              disabled={fileBusy || stopping || stage === 'saving'} onFiles={files => void openFiles(files)} />
            {stage === 'requesting' ? (
              <Button variant="ghost" onClick={cancelRecording}>Cancel</Button>
            ) : null}
          </>
        ) : null}
      </Container>

      {permissionState && recordAudioCapabilityPermission && !activeCapture && stage !== 'saving' ? (
        <CapabilityPermissionPrompt
          descriptor={recordAudioCapabilityPermission}
          state={permissionState}
          requesting={stage === 'requesting'}
          onRequest={() => void startRecording('audio')}
        />
      ) : null}

      {message.trim() && !recoverableError && stage !== 'terminal-error' ? (
        <Text variant="body-xs" color="faint">{message}</Text>
      ) : null}

      {recoverableError && currentLiveRecording() ? (
        <Button
          variant="primary"
          onClick={() => {
            setStage('saving');
            const activeSession = currentLiveRecording()?.session;
            if (!activeSession) return;
            void finishSession(activeSession.recordingId).catch((error: unknown) => {
              void recordError(activeSession.recordingId, activeSession.mode, error);
            });
          }}
        >
          Save recording again
        </Button>
      ) : null}

    </Container>
  );

  return (
    <ArrangedContents pieces={[
      { id: 'capture-controls', label: recordingLibraryLayout.composition.capture_label, content: capturePane },
      { id: 'recording-library', label: recordingLibraryLayout.label, content: (
        <ToastProvider>
          <ErrorBoundary surfaceName="Recording library">
            <RecordingBoard onOpenRecording={onOpenRecording}
              configuration={recordingLibraryConfiguration}
              initialConfigurationId={recordingLibraryConfigurationId}
              ruleOperators={recordingLibraryRuleOperators}
              loadFilterRecords={recordingLibraryLoadFilterRecords} />
          </ErrorBoundary>
        </ToastProvider>
      ) },
    ]} arrangement={recordingLibraryLayout.composition.arrangement}
      keptAt={recordingLibraryLayout.composition.kept_at}
      words={recordingLibraryLayout.composition.words} />
  );
}
