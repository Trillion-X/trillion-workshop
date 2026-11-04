//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The one screen for recording audio or video. Press Start, talk, press Stop.
// The recording is saved through owner workflow actions into current log
// state, appears in the list below, can be played, renamed inline, and
// removed. Every listed fact is decoded from the package's `recordings`
// input (current log state) — never from component memory — so recordings
// survive rename, tab switches, reloads, and app restarts.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Saved-recording truth comes only from useBitfieldData('recordVideoRecordings').
//    Component state holds only the in-flight capture session and transient
//    playback object URLs.
// 2. Every mutation (save, rename, remove) goes through an owner workflow
//    action; the action republishes the recordings feed.
// 3. All styling through shared UI and screen-look tokens. Raw media
//    elements live only inside shared media components.
// 4. Diagnostics are captured always (console) but rendered only in the
//    error state — internal vocabulary never sits on the default screen.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { useBitfieldData } from '#workspace-records';

import {
  activeSentenceIndexForCursor,
  alignRecognizedWords,
  decodeRecordingSession,
  decodeCompletionReasonRefs,
  decodeRecordingCapturePolicy,
  RECORDING_CAPTURE_POLICY_INPUT,
  RECORDING_COMPLETION_REASON_REFS_INPUT,
  reachedScriptCompletion,
  heardStopPhrase,
  RECORDING_SESSION_INPUT,
  type RecordingCompletionReasonRefs,
  type RecordingTeleprompterSession,
} from '../read-data/recording-session';
import {
  createRecordVideoId,
  removeRecording,
  saveRecordedFile,
  saveRecordingError,
  saveRecordingState,
  setRecordingName,
  setRecordingSubtitle,
  type CaptureDescriptorValue,
} from '../do-work/record-video-requests';
import {
  saveRecordedFileArtifact,
  type RecordVideoSourceRef,
} from '../do-work/recorded-file-artifact';
import { presentationReadinessFromObservations } from '../do-work/recording-session-from-presentation-plan.mjs';
import {
  readRecordedFileBlob,
  storedRecordedFileRef,
  storeRecordingChunk,
  storeRecordingChunkWithRetry,
  captureJournalRecoveryState,
  writeCaptureJournal,
  listCaptureJournals,
  deleteCaptureJournal,
  type LocalPlaybackFileRef,
} from '../do-work/recorded-file-store';
import {
  decodeEnrichmentsByRecording,
  type RecordingEnrichment,
} from '../read-data/recording-enrichment';
import { RecordingEnrichmentPanel } from './RecordingEnrichmentPanel';
import {
  chooseLocalFiles,
  type LocalChosenFile,
} from '../../local-files/do-work/choose-local-files';
import {
  capturePermissionState,
  isPermissionError,
  mediaCaptureAvailability,
  mediaStreamForMode,
  recordVideoCapabilityPermissionForMode,
} from './browser-media-capture';
import {
  observeMediaDeviceChanges,
  observeBrowserMediaSetup,
  readinessObservationsFromSetup,
  type SetupObservationReport,
} from './setup-observer';
import { CapabilityPermissionPrompt } from '../../permission-lease/show/CapabilityPermissionPrompt';
import type { CapabilityPermissionState } from '../../permission-lease/read-data/capability-permission';
import { AudioClipPlayer, Button, CaptionScroll, Container, Icon, InlineEditText, LiveWaveform, SegmentedControl, Text, sanitizeErrorText } from '../../ui';
import { ActionMenu, type ActionMenuItem } from '../../ui/show/action-menu';
import type { FieldDescriptor } from '../../ui/show/record-views/record-views';
import { later } from '../../ui/show/load-later/later';
// A recording's facts are drawn by the shared record fields, fetched when the facts first show.
const RecordFacts = later(() => import('../../ui/show/record-views/record-views'), module => module.RecordFacts);
import { useMadePreview, type MadePreviewStore } from '../../ui/show/media-preview';
import { downloadAddress } from '../../ui/show/file-download/download-file';
import { starterFilledFrom, type StarterLayout } from '../../screen-arrangement/read-data/starter-layouts';
import type { NavSectionData } from '../../sidebar/show/SidebarContent';
import { emitPlaceableSurfaceIntent, findPlaceableSurfaces, readPublishedRecords } from '../../ui/show/placeable-surface-intent';
import { MediaFrame } from '../../ui/show/media-frame/MediaFrame';
import { MediaPlaybackSurface } from '../../media-playback/show/lazy-playback-surface';
import { AppSidebar } from '../../sidebar/show/AppSidebar';
import { admitPlaceableSurfaceSubject } from '../../ui/show/placeable-surface-intent/placeable-surface-subject';
import { EmbeddedScreenArrangementView } from '../../screen-arrangement/show/EmbeddedScreenArrangement';
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
  pauseActiveTime,
  resumeActiveTime,
  type RecordingPhase,
} from './recording-lifecycle';
import {
  advanceSilenceStop,
  INITIAL_SILENCE_STOP_STATE,
  rootMeanSquare,
} from './silence-stop';
import { RECORDING_PAGE_LAYOUT_STATE_INPUT, recordingPageLayoutAddress } from '../read-data/recording-page-arrangement';
import { Mic, Pause, Play, Square } from 'lucide-react';
import { hasNativeSpeechBridge, listen as listenForWords, listeningContext, type Heard, type Listener } from '../../record-audio/show/record-in-the-browser';
import { loopFreeWords, withoutLoops } from '../../record-audio/read-data/heard-words.mjs';

import { errorWords } from '../../ui/show/safe-error-card/sanitize-error-text';
type SurfaceCatalogEntry = ReturnType<typeof findPlaceableSurfaces>[number];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The self-describing material kind a recording offers to other surfaces.
 * Society vocabulary lives in DATA (this package's evidence records declare
 * the same role strings) — consumers match `accepts_material_kinds`, never
 * package names.
 */
function recordingMaterialKind(recording: ListedRecording): string {
  return recording.sourceRef?.role ?? '';
}

type RecordingStage = 'idle' | RecordingPhase;

type SavedRecording = {
  recordingId: string;
  recordedFileId: string;
  mode: CaptureDescriptorValue;
  mediaType: string;
  durationMs: number;
  playbackUrl: string;
  recordedAt: string;
  sourceRef: RecordVideoSourceRef;
};

type RecordingSession = LiveRecordingSession;

type ListedRecording = {
  id: string;
  label: string;
  subtitle: string;
  notes: string;
  mode: CaptureDescriptorValue;
  mediaType: string;
  byteLength: number;
  durationMs: number;
  recordedAt: string;
  storedFileRef: LocalPlaybackFileRef | null;
  sourceRef: RecordVideoSourceRef | null;
  completionReasonRef: string;
  completionObservedAt: string;
  artifactDisposition: string;
  /** The words heard while recording, kept as their own file beside it (its identity), when any were heard. */
  transcriptFile: string;
};

type RecordVideoPanelProps = {
  now?: () => Date;
  // Trillion: what the screen around the panel offers beside the title before recording (Have my AI write it).
  captureActions?: React.ReactNode;
  // Trillion: what the screen around the panel offers while a recording runs (a run of takes' Stop takes).
  liveCaptureActions?: React.ReactNode;
  onCaptureActiveChange?: (active: boolean) => void;
  /** The screens a recording's page opens on (starter DATA over one recording: `{ from: 'record', key }` values), as
   *  the app running the panel declares them; with none, the page shows the recording and its facts only. */
  pageScreens?: StarterLayout | null;
  /** The address of the app's screens list, from which a page's screens are opened. */
  surfaceListAddressLabel?: string;
  /** Where a recording's still is kept and read (beside its file), so the page opens on a picture. */
  previewStore?: MadePreviewStore;
  /** The app's own rows for a recording's ⋯ menu (Share, …), ahead of the part's own. */
  recordingMenuRows?: readonly RecordingMenuRow[];
  /** Trillion: told once a recording is saved, so the screen around the panel can bring up the next take. */
  onRecordingSaved?: (recording: { recordedFileId: string; durationMs: number; completionReasonRef: string | null }) => void;
};

type TeleprompterStatus = {
  label: string;
  problem: boolean;
};

type CompletionReasonKey = keyof RecordingTeleprompterSession['completionReasonRefs'];

function completionReasonRef(live: LiveRecording | null, key: CompletionReasonKey): string {
  return live?.completionReasonRefs[key] ?? decodeCompletionReasonRefs(null)[key];
}

function captureJournal(live: LiveRecording, phase = live.phase) {
  live.session.journalRevision += 1;
  const updatedAtMs = Date.now();
  return {
    recording_id: live.session.recordingId,
    recorded_file_id: live.session.recordedFileId,
    recorded_at: live.session.recordedAt,
    phase,
    capture_kind: live.session.mode,
    media_type: live.session.mediaType,
    completion_reason_ref: live.completion?.reasonRef ?? null,
    completion_source_ref: live.completion?.sourceRef ?? null,
    completion_observed_at: live.completion ? new Date(live.completion.observedAtMs).toISOString() : null,
    active_duration_ms: activeDurationMs(live.session.timing, Date.now()),
    expected_sequences: Array.from({ length: live.session.sequence }, (_, sequence) => sequence),
    stored_sequences: [...live.session.chunkResults.keys()].sort((left, right) => left - right),
    failed_sequences: [...live.session.chunkFailures.keys()].sort((left, right) => left - right),
    owner_instance_ref: live.session.ownerInstanceRef,
    owner_lease_expires_at: new Date(updatedAtMs + live.session.journalLeaseMs).toISOString(),
    journal_revision: live.session.journalRevision,
    updated_at: new Date(updatedAtMs).toISOString(),
  };
}

type SpeechRecognitionResultLike = {
  0: { transcript: string };
  isFinal?: boolean;
};

type SpeechRecognitionEventLike = {
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const defaultNow = () => new Date();

const RECORD_VIDEO_EXTENSIONS = [
  'avi',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'mpeg',
  'mpg',
  'webm',
];
const RECORD_AUDIO_EXTENSIONS = ['aac', 'aif', 'aiff', 'flac', 'm4a', 'mp3', 'ogg', 'wav', 'webm'];
const RECORDING_EXTENSIONS = [...new Set([...RECORD_VIDEO_EXTENSIONS, ...RECORD_AUDIO_EXTENSIONS])];

function mediaRecorderConstructor(): typeof MediaRecorder | null {
  return typeof MediaRecorder === 'undefined' ? null : MediaRecorder;
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const recognitionWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return recognitionWindow.SpeechRecognition ?? recognitionWindow.webkitSpeechRecognition ?? null;
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

function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function recordedWhenLabel(recordedAt: string, now: () => Date): string {
  const at = new Date(recordedAt);
  if (Number.isNaN(at.getTime())) return '';
  const current = now();
  const sameDay = at.toDateString() === current.toDateString();
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
  if (sameDay) return time;
  const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at);
  return `${day}, ${time}`;
}

function defaultRecordingLabel(mode: CaptureDescriptorValue, at: Date): string {
  const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at);
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
  return `${mode === 'video' ? 'Video' : 'Recording'} ${day} ${time}`;
}

function plainError(error: unknown): string {
  if (isPermissionError(error)) {
    return 'Camera and microphone access is needed. Click Enable camera & microphone and choose Allow once — after that, recordings start by themselves.';
  }
  return errorWords(error, 'Recording could not be completed.');
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
  if (file.contentType.startsWith('video/')) return 'video';
  if (file.contentType.startsWith('audio/')) return 'audio';
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  return RECORD_AUDIO_EXTENSIONS.includes(extension) && extension !== 'webm' ? 'audio' : 'video';
}

function teleprompterMetaLabel(session: RecordingTeleprompterSession, cursor: number): string {
  const safeCursor = Math.max(0, Math.min(session.words.length - 1, cursor));
  const sentenceIndex = Math.max(0, activeSentenceIndexForCursor(session, safeCursor));
  return `Sentence ${sentenceIndex + 1} of ${session.sentences.length} · word ${Math.min(safeCursor + 1, session.words.length)} of ${session.words.length}`;
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function startSilenceStopMonitor(
  stream: MediaStream,
  session: RecordingTeleprompterSession,
  onSilenceComplete: () => void,
  onObservationUnavailable: (detail: string) => void,
  maximumSampleGapMs: number,
): (() => void) | null {
  if (session.silenceStopSeconds <= 0) return null;
  if (stream.getAudioTracks().length === 0) throw new Error('Required silence stop has no audio track.');
  const Context = typeof window === 'undefined' ? null : window.AudioContext;
  if (!Context) throw new Error('Required silence stop has no AudioContext provider.');
  let context: AudioContext;
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    context = new Context();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
  } catch (error) {
    throw new Error(`Required silence stop could not start: ${diagnosticErrorDetail(error)}`);
  }
  analyser.fftSize = 2048;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let state = INITIAL_SILENCE_STOP_STATE;
  let lastSampleAt = performance.now();
  let stopped = false;
  let availabilityFailureReported = false;
  void context.resume().catch(() => undefined);
  const timer = window.setInterval(() => {
    const sampledAt = performance.now();
    if (currentLiveRecording()?.recorder?.state !== 'recording') {
      lastSampleAt = sampledAt;
      return;
    }
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack || audioTrack.readyState !== 'live' || audioTrack.muted) {
      if (!availabilityFailureReported) {
        availabilityFailureReported = true;
        onObservationUnavailable(
          !audioTrack
            ? 'The selected capture provider no longer exposes an audio track.'
            : `The selected audio track is ${audioTrack.readyState}${audioTrack.muted ? ' and muted' : ''}.`,
        );
      }
      lastSampleAt = sampledAt;
      return;
    }
    if (context.state !== 'running') {
      if (!availabilityFailureReported) {
        availabilityFailureReported = true;
        onObservationUnavailable(`AudioContext is ${context.state}.`);
      }
      lastSampleAt = sampledAt;
      return;
    }
    analyser.getFloatTimeDomainData(samples);
    const decision = advanceSilenceStop(state, rootMeanSquare(samples), sampledAt - lastSampleAt, {
      thresholdRms: session.silenceThresholdRms,
      minimumSpeechMs: session.minimumSpeechMs,
      requiredSilenceMs: session.silenceStopSeconds * 1000,
      maximumSampleGapMs,
    });
    state = decision.state;
    lastSampleAt = sampledAt;
    if (decision.observation === 'unknown') {
      if (!availabilityFailureReported) {
        availabilityFailureReported = true;
        onObservationUnavailable('Audio samples became stale after a scheduler or device gap.');
      }
      return;
    }
    if (decision.shouldStop && !stopped) {
      stopped = true;
      onSilenceComplete();
    }
  }, 100);
  return () => {
    window.clearInterval(timer);
    source.disconnect();
    analyser.disconnect();
    void context.close();
  };
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function rowText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function rowNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function decodeListedRecordings(rows: unknown): ListedRecording[] {
  if (!Array.isArray(rows)) return [];
  const listed: ListedRecording[] = [];
  for (const candidate of rows) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const row = candidate as Record<string, unknown>;
    const id = rowText(row, 'id');
    if (!id) continue;
    const storedFileRef = (
      typeof row.storedFileRef === 'object'
      && row.storedFileRef !== null
      && !Array.isArray(row.storedFileRef)
    )
      ? row.storedFileRef as LocalPlaybackFileRef
      : null;
    const sourceRef = (
      typeof row.sourceRef === 'object'
      && row.sourceRef !== null
      && !Array.isArray(row.sourceRef)
    )
      ? row.sourceRef as RecordVideoSourceRef
      : null;
    listed.push({
      id,
      label: rowText(row, 'label'),
      subtitle: rowText(row, 'subtitle'),
      notes: rowText(row, 'notes'),
      mode: rowText(row, 'mode') === 'video' ? 'video' : 'audio',
      mediaType: rowText(row, 'mediaType'),
      byteLength: rowNumber(row, 'byteLength'),
      durationMs: rowNumber(row, 'durationMs'),
      recordedAt: rowText(row, 'recordedAt'),
      storedFileRef,
      sourceRef,
      completionReasonRef: rowText(row, 'completionReasonRef'),
      completionObservedAt: rowText(row, 'completionObservedAt'),
      artifactDisposition: rowText(row, 'artifactDisposition'),
      transcriptFile: rowText(row, 'transcriptFile'),
    });
  }
  listed.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
  return listed;
}

function recordingGroupLabel(isoDate: string, now: () => Date): { id: string; label: string } {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return { id: 'older', label: 'Older' };
  const current = now();
  const todayStart = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysAgo = Math.floor((todayStart - dayStart) / 86_400_000);
  if (daysAgo <= 0) return { id: 'today', label: 'Today' };
  if (daysAgo === 1) return { id: 'yesterday', label: 'Yesterday' };
  if (daysAgo < 7) return { id: 'last-7-days', label: 'Last 7 days' };
  if (daysAgo < 30) return { id: 'last-30-days', label: 'Last 30 days' };
  return { id: 'older', label: 'Older' };
}

function groupRecordingsByDate(
  recordings: readonly ListedRecording[],
  now: () => Date,
): { id: string; label: string; items: ListedRecording[] }[] {
  const groups = new Map<string, { id: string; label: string; items: ListedRecording[] }>();
  for (const recording of recordings) {
    const key = recordingGroupLabel(recording.recordedAt, now);
    const existing = groups.get(key.id);
    if (existing) {
      existing.items.push(recording);
      continue;
    }
    groups.set(key.id, { id: key.id, label: key.label, items: [recording] });
  }
  return Array.from(groups.values());
}

function filterRecordings(recordings: readonly ListedRecording[], search: string): ListedRecording[] {
  const normalized = search.trim().toLowerCase();
  if (!normalized) return [...recordings];
  return recordings.filter((recording) => recording.label.toLowerCase().includes(normalized));
}

function createdLabel(recordedAt: string): string {
  const at = new Date(recordedAt);
  if (Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
}

type RecordingPageProps = {
  recording: ListedRecording;
  completionReasonRefs: RecordingCompletionReasonRefs;
  enrichment: RecordingEnrichment | null;
  playbackUrl: string | null;
  loadingPlayback: boolean;
  menuRows: readonly RecordingMenuRow[];
  onMenuAction: (id: string) => void;
  onRename: (label: string) => void;
  onSubtitle: (subtitle: string) => void;
  pageStarter: StarterLayout | null;
  surfaceListAddressLabel: string;
  previewStore: MadePreviewStore | undefined;
  layoutEntry: unknown;
  publishedRecordsEntry: unknown;
  placeableSurfaceListEntry: unknown;
};

/** One row of a recording's ⋯ menu: the shared action menu's row, run by whoever offered it. */
export type RecordingMenuRow = ActionMenuItem & { run?: (recording: RecordingPageRecord) => void };
/** What the app's own menu rows are told about the recording they act on. */
export type RecordingPageRecord = { id: string; label: string; fileRef: string | null; mediaType: string };

function completionReasonLabel(reasonRef: string, refs: RecordingCompletionReasonRefs): string {
  if (reasonRef === refs.manual) return 'Stopped manually';
  if (reasonRef === refs.speech) return 'Script finished';
  if (reasonRef === refs.silence) return 'Stopped after silence';
  if (reasonRef === refs.duration) return 'Time limit reached';
  if (reasonRef === refs.providerEnd) return 'Camera or microphone ended';
  if (reasonRef === refs.providerError) return 'Camera or microphone had a problem';
  if (reasonRef === refs.cancel) return 'Cancelled';
  return 'Finished';
}

// A recording saved the ordinary way says nothing about how it was saved; only an unusual one does.
function mediaDispositionLabel(disposition: string): string {
  if (disposition === 'saved-with-capture-error') return 'Saved after a capture problem';
  if (disposition === 'imported') return 'Added from a file';
  return '';
}

function downloadFileName(recording: ListedRecording): string {
  const base = (recording.label || 'Recording').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'Recording';
  const subtype = recording.mediaType.split(';')[0]?.split('/')[1] ?? '';
  const extension = subtype === 'mpeg' ? 'mp3' : subtype || (recording.mode === 'video' ? 'mp4' : 'm4a');
  return `${base}.${extension}`;
}

/** The file a recording was kept as in the person's files (`file:<identity>`), when it was kept there. */
function recordingFileRef(recording: ListedRecording): string | null {
  const relation = (recording.sourceRef as { artifact_ref?: { relation_ref?: unknown } } | null)?.artifact_ref?.relation_ref;
  return typeof relation === 'string' && relation.startsWith('file:') ? relation : null;
}

/** What a recording's page fills its declared screens from: its notes' own address and its transcript file. */
function recordingPageValues(recording: ListedRecording): Record<string, unknown> {
  return {
    id: recording.id,
    notes_address: `record-notes::${recording.id}`,
    transcript_file: recording.transcriptFile || null,
    file: recordingFileRef(recording)?.slice('file:'.length) ?? null,
  };
}

// A recording's facts, as the shared record fields every record page draws (record-views RecordFacts).
function recordingFields(refs: RecordingCompletionReasonRefs): FieldDescriptor[] {
  return [
    { id: 'recorded', label: 'Recorded', read: (recording: ListedRecording) => createdLabel(recording.recordedAt) },
    { id: 'length', label: 'Length', read: (recording: ListedRecording) => (recording.durationMs > 0 ? elapsedLabel(recording.durationMs) : '') },
    { id: 'ended', label: 'Ended', read: (recording: ListedRecording) => (recording.completionReasonRef ? completionReasonLabel(recording.completionReasonRef, refs) : '') },
    { id: 'saved', label: 'Saved', read: (recording: ListedRecording) => mediaDispositionLabel(recording.artifactDisposition) },
  ];
}

function RecordingPage({
  recording,
  completionReasonRefs,
  enrichment,
  playbackUrl,
  loadingPlayback,
  menuRows,
  onMenuAction,
  onRename,
  onSubtitle,
  pageStarter,
  surfaceListAddressLabel,
  previewStore,
  layoutEntry,
  publishedRecordsEntry,
  placeableSurfaceListEntry,
}: RecordingPageProps) {
  const fileIdentity = recordingFileRef(recording)?.slice('file:'.length) ?? null;
  // The recording's still: kept beside its file the moment it was saved (or made now from the copy in hand), so the
  // page opens on a picture, never a black frame waiting for play.
  const made = useMadePreview(
    recording.mode === 'video' ? fileIdentity : null,
    playbackUrl ?? undefined,
    recording.mediaType || 'video/webm',
    previewStore,
  );
  const fields = React.useMemo(() => recordingFields(completionReasonRefs), [completionReasonRefs]);
  const starter = React.useMemo(() => {
    if (!pageStarter) return null;
    const arrangement = starterFilledFrom(pageStarter.arrangement, recordingPageValues(recording));
    return arrangement ? { ...pageStarter, arrangement } : null;
  }, [pageStarter, recording]);

  return (
    <Container layout="vertical" gap="lg" padding="lg" overflow="y-auto" flex={1} className="min-w-0">
      <Container layout="horizontal" gap="sm" alignItems="start">
        <Container layout="vertical" gap="xs" flex={1} className="min-w-0">
          <InlineEditText
            value={recording.label}
            variant="heading-xl"
            aria-label="Recording name"
            onCommit={onRename}
          />
          <InlineEditText
            value={recording.subtitle}
            variant="body"
            tone="secondary"
            placeholder="Add a subtitle"
            aria-label="Recording subtitle"
            onCommit={onSubtitle}
          />
        </Container>
        <ActionMenu label={`Actions for ${recording.label || 'this recording'}`} items={menuRows} onAction={onMenuAction} align="end" />
      </Container>

      <Container layout="vertical" gap="none" className="min-w-0">
        {playbackUrl ? (
          recording.mode === 'video' ? (
            <MediaPlaybackSurface
              media={{
                id: recording.id,
                label: recording.label,
                source_kind: 'video',
                mime_type: recording.mediaType || 'video/webm',
                playback_url: playbackUrl,
                ...(made?.poster ? { poster_url: made.poster } : {}),
              }}
              showFrameChrome={false}
            />
          ) : (
            <AudioClipPlayer src={playbackUrl} downloadName={downloadFileName(recording)} />
          )
        ) : (
          <Text variant="body-xs" color="faint">
            {loadingPlayback ? 'Loading' : 'Not playable'}
          </Text>
        )}
      </Container>

      <RecordFacts fields={fields} record={recording} recordId={recording.id} label="About this recording" />

      {enrichment ? (
        <RecordingEnrichmentPanel
          enrichment={enrichment}
          currentLabel={recording.label}
          currentSubtitle={recording.subtitle}
          onApplyTitle={onRename}
          onApplySubtitle={onSubtitle}
        />
      ) : null}

      {/*
        The page's content region IS a screen arrangement (media-composition's embedded pattern), opened on the screens
        the app declares for a recording (its notes, its transcript) and kept for this recording alone; the person can
        rearrange, close, or drop any other screen in. It never opens on an empty picker.
      */}
      {starter ? (
        <Container layout="vertical" gap="none" flex={1} className="min-h-[26rem] min-w-0">
          <EmbeddedScreenArrangementView
            key={recording.id}
            starter={starter}
            layoutEntry={layoutEntry}
            publishedRecordsEntry={publishedRecordsEntry}
            placeableSurfaceListEntry={placeableSurfaceListEntry}
            placeableSurfaceListAddressLabel={surfaceListAddressLabel}
            persistence={{ valueAddressLabel: recordingPageLayoutAddress(recording.id) }}
            chrome={{ 'header.actions': false, 'header.new-tab': false }}
          />
        </Container>
      ) : null}
    </Container>
  );
}

export function RecordVideoPanel({ now = defaultNow, captureActions, liveCaptureActions, onCaptureActiveChange, pageScreens = null, surfaceListAddressLabel = 'placeable-surface-list::recording-workspace', previewStore, recordingMenuRows = [], onRecordingSaved }: RecordVideoPanelProps) {
  // Trillion: the words heard while recording without a script, shown over the picture and kept as the transcript.
  const wordsRef = React.useRef<Listener | null>(null);
  const heardBaseRef = React.useRef('');
  const [heard, setHeard] = React.useState<Heard>({ final: '', hearing: '' });
  // Trillion: a line heard again and again back to back is shown and kept once (record-audio's heard-words.json).
  const loopFree = React.useRef(loopFreeWords());
  const shownFinal = React.useMemo(() => loopFree.current(heard.final), [heard.final]);
  const [wordsNote, setWordsNote] = React.useState('');
  const recognitionRef = React.useRef<SpeechRecognitionLike | null>(null);
  const recognitionBaseRef = React.useRef(0);
  const restartRecognitionRef = React.useRef(false);
  const autoStartedSessionIdRef = React.useRef<string | null>(null);
  const teleprompterCursorRef = React.useRef(0);
  const confirmedTeleprompterCursorRef = React.useRef(0);
  const playbackUrlRef = React.useRef<string | null>(null);
  const listPlaybackUrlRef = React.useRef<string | null>(null);
  const [stage, setStage] = React.useState<RecordingStage>('idle');
  const [mode, setMode] = React.useState<CaptureDescriptorValue>('video');
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const [savedRecording, setSavedRecording] = React.useState<SavedRecording | null>(null);
  const [message, setMessage] = React.useState('');
  const [awaitingPermission, setAwaitingPermission] = React.useState(false);
  const [permissionState, setPermissionState] = React.useState<CapabilityPermissionState>('undetermined');
  const [pageMedia, setPageMedia] = React.useState<{ id: string; url: string } | null>(null);
  const [loadingPlaybackId, setLoadingPlaybackId] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [countdownValue, setCountdownValue] = React.useState<number | null>(null);
  const [teleprompterCursor, setTeleprompterCursor] = React.useState(0);
  const [confirmedSpeechComplete, setConfirmedSpeechComplete] = React.useState(false);
  // Trillion: when a word was last heard in this take, and the stop phrase heard, if any (session invariant 5).
  const lastHeardAtRef = React.useRef(0);
  const lastHeardTextRef = React.useRef('');
  const [stopPhraseHeard, setStopPhraseHeard] = React.useState<string | null>(null);
  const onRecordingSavedRef = React.useRef(onRecordingSaved);
  onRecordingSavedRef.current = onRecordingSaved;
  const [teleprompterStatus, setTeleprompterStatus] = React.useState<TeleprompterStatus>({
    label: 'Speech follower',
    problem: false,
  });
  const [activeTeleprompterSession, setActiveTeleprompterSession] = React.useState<RecordingTeleprompterSession | null>(null);
  const [setupCheckReport, setSetupCheckReport] = React.useState<SetupObservationReport | null>(null);
  const [setupChecking, setSetupChecking] = React.useState(false);
  const [availableCapabilities, setAvailableCapabilities] = React.useState<string[]>([]);
  const [claimReviewed, setClaimReviewed] = React.useState(false);
  const [capturePermitted, setCapturePermitted] = React.useState(false);
  const [recoveryScanNonce, setRecoveryScanNonce] = React.useState(0);
  const [readinessResult, setReadinessResult] = React.useState<{ state: string; problems: unknown[] } | null>(null);
  const [evaluatingReadiness, setEvaluatingReadiness] = React.useState(false);
  // No local panel geometry. Position, width, float, hide and auto-hide are a
  // durable `sidebar-placement` record the person owns, not browser state that
  // dies with the tab.
  const [search, setSearch] = React.useState('');

  const recordingRows = useBitfieldData('recordVideoRecordings');
  const recordings = React.useMemo(() => decodeListedRecordings(recordingRows), [recordingRows]);
  const recordingSessionValue = useBitfieldData(RECORDING_SESSION_INPUT);
  const completionReasonRefsValue = useBitfieldData(RECORDING_COMPLETION_REASON_REFS_INPUT);
  const capturePolicyValue = useBitfieldData(RECORDING_CAPTURE_POLICY_INPUT);
  const packageCompletionReasonRefs = React.useMemo(
    () => decodeCompletionReasonRefs(completionReasonRefsValue),
    [completionReasonRefsValue],
  );
  const capturePolicy = React.useMemo(
    () => decodeRecordingCapturePolicy(capturePolicyValue),
    [capturePolicyValue],
  );
  const teleprompterSession = React.useMemo(
    () => decodeRecordingSession(recordingSessionValue),
    [recordingSessionValue],
  );
  const publishedRows = useBitfieldData('published-records');
  // The open recording's own page arrangement, kept at its own address (recording-page-arrangement.ts).
  const recordingPageLayoutEntry = useBitfieldData({
    input: RECORDING_PAGE_LAYOUT_STATE_INPUT,
    params: { addressLabel: selectedId ? recordingPageLayoutAddress(selectedId) : '' },
  });
  const recordingWorkspaceSurfaces = useBitfieldData({
    input: 'placeable-surface-list-by-address-label',
    params: { addressLabel: surfaceListAddressLabel },
  });
  const publishedRecords = React.useMemo(() => readPublishedRecords(publishedRows), [publishedRows]);
  const surfaceCatalog = React.useMemo(() => findPlaceableSurfaces(publishedRecords), [publishedRecords]);
  const enrichmentByRecording = React.useMemo(
    () => decodeEnrichmentsByRecording(publishedRecords),
    [publishedRecords],
  );
  const visibleRecordings = React.useMemo(() => filterRecordings(recordings, search), [recordings, search]);
  const sidebarGroups = React.useMemo(
    () => groupRecordingsByDate(visibleRecordings, now),
    [visibleRecordings, now],
  );
  // The SAME date groups as the shared sidebar's own sections (as Messages lists its conversations): one section per
  // day group, one row per recording with its Remove action. Recordings stay the source of truth; nothing is written
  // into sidebar membership.
  const recordingSections = React.useMemo<NavSectionData[]>(() => sidebarGroups.map((group) => ({
    id: group.id,
    title: group.label,
    items: group.items.map((recording) => ({
      id: recording.id,
      label: recording.label || 'Recording',
      icon: recording.mode === 'video' ? 'Video' : 'Mic',
      actions: [{ id: 'remove', label: 'Remove', icon: 'Trash2', tone: 'destructive' }],
    })),
  })), [sidebarGroups]);
  const selectedRecording = React.useMemo(
    () => (selectedId ? recordings.find((recording) => recording.id === selectedId) ?? null : null),
    [recordings, selectedId],
  );
  const effectiveTeleprompterSession = activeTeleprompterSession ?? teleprompterSession;

  const invalidateSetupEvidence = React.useCallback((notice?: string) => {
    setSetupCheckReport(null);
    setAvailableCapabilities([]);
    setReadinessResult(null);
    setClaimReviewed(false);
    setCapturePermitted(false);
    if (notice) setMessage(notice);
  }, []);

  React.useEffect(() => observeMediaDeviceChanges(() => {
    // Browsers can fire devicechange when capture opens or device labels become
    // available. The recorder already watches its acquired tracks for `ended`;
    // a registry change must not replace the status of an in-flight recording.
    const active = currentLiveRecording();
    if (active && !['saved', 'cancelled', 'terminal-error'].includes(active.phase)) return;
    invalidateSetupEvidence('Camera or microphone changed. Check setup again.');
  }), [invalidateSetupEvidence]);

  const readinessSessionId = effectiveTeleprompterSession?.sessionId ?? null;
  const previousReadinessSessionIdRef = React.useRef<string | null>(readinessSessionId);
  React.useEffect(() => {
    if (previousReadinessSessionIdRef.current === readinessSessionId) return;
    previousReadinessSessionIdRef.current = readinessSessionId;
    invalidateSetupEvidence();
  }, [invalidateSetupEvidence, readinessSessionId]);

  const clearPlaybackUrl = React.useCallback(() => {
    if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
    playbackUrlRef.current = null;
  }, []);

  const createPlaybackUrl = React.useCallback((blob: Blob) => {
    clearPlaybackUrl();
    const playbackUrl = URL.createObjectURL(blob);
    playbackUrlRef.current = playbackUrl;
    return playbackUrl;
  }, [clearPlaybackUrl]);

  const closePageMedia = React.useCallback(() => {
    if (listPlaybackUrlRef.current) URL.revokeObjectURL(listPlaybackUrlRef.current);
    listPlaybackUrlRef.current = null;
    setPageMedia(null);
  }, []);

  const clearAutoStopTimer = React.useCallback(() => {
    const active = currentLiveRecording();
    if (active && active.autoStopTimeout !== null) {
      window.clearTimeout(active.autoStopTimeout);
      active.autoStopTimeout = null;
    }
    if (active?.silenceMonitorCleanup) {
      active.silenceMonitorCleanup();
      active.silenceMonitorCleanup = null;
    }
  }, []);

  const setTeleprompterMode = React.useCallback((label: string, problem = false) => {
    setTeleprompterStatus({ label, problem });
  }, []);

  const stopSpeechFollower = React.useCallback(() => {
    wordsRef.current?.stop();
    wordsRef.current = null;
    restartRecognitionRef.current = false;
    const recognition = recognitionRef.current;
    if (!recognition) return;
    recognition.onend = null;
    try {
      recognition.stop();
    } catch {
      // Ignore stop races from browsers that already ended recognition.
    }
    recognitionRef.current = null;
  }, []);

  const recordDiagnostic = React.useCallback((event: string, detail: string) => {
    console.info(`[record-video] ${event}`, detail);
  }, []);

  React.useEffect(() => {
    recordDiagnostic('recording surface ready', recordingEnvironment());
  }, [recordDiagnostic]);

  React.useEffect(() => {
    let cancelled = false;
    let recoveryTimer: number | null = null;
    void listCaptureJournals().then(async (journals) => {
      const incomplete = journals.filter((journal) => !['saved', 'cancelled'].includes(journal.phase));
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
        setMessage(`${interruptedCount} interrupted capture${interruptedCount === 1 ? '' : 's'} found. Saved chunks were preserved; no successful take was fabricated.`);
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
    if (effectiveTeleprompterSession) {
      setTeleprompterCursor(0);
      confirmedTeleprompterCursorRef.current = 0;
      setConfirmedSpeechComplete(false);
      setStopPhraseHeard(null);
      setTeleprompterMode(effectiveTeleprompterSession.statusLabel, false);
      return;
    }
    setTeleprompterCursor(0);
    setTeleprompterMode('Speech follower', false);
  }, [effectiveTeleprompterSession?.sessionId, effectiveTeleprompterSession?.statusLabel, setTeleprompterMode]);

  React.useEffect(() => {
    teleprompterCursorRef.current = teleprompterCursor;
  }, [teleprompterCursor]);

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
        current === 'recording' || current === 'paused' || current === 'countdown'
          || current === 'requesting' || current === 'saving'
          ? 'idle'
          : current
      ));
      setElapsedMs(0);
      return;
    }
    setMode(active.session.mode);
    setStage(active.phase);
    setElapsedMs(activeDurationMs(active.session.timing, Date.now()));
    setCountdownValue(active.countdownValue);
    if (active.teleprompter) {
      setActiveTeleprompterSession(active.teleprompter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveVersion]);

  React.useEffect(() => () => {
    // Unmount detaches THIS view only. The module-owned live recording,
    // its auto-stop timer, recorder, and stream keep running; any other
    // instance (or a remount of this one) can still stop and save it.
    stopSpeechFollower();
    clearPlaybackUrl();
    if (listPlaybackUrlRef.current) URL.revokeObjectURL(listPlaybackUrlRef.current);
    listPlaybackUrlRef.current = null;
  }, [clearPlaybackUrl, stopSpeechFollower]);

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
        recording.countdownValue = null;
      });
    }
    recordDiagnostic('recording error', diagnosticErrorDetail(error));
    clearAutoStopTimer();
    stopSpeechFollower();
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
  }, [clearAutoStopTimer, now, recordDiagnostic, stopSpeechFollower]);

  const moveTeleprompterCursor = React.useCallback((nextCursor: number) => {
    const session = effectiveTeleprompterSession;
    if (!session) return;
    const clamped = Math.max(0, Math.min(session.words.length - 1, nextCursor));
    recognitionBaseRef.current = clamped;
    teleprompterCursorRef.current = clamped;
    setTeleprompterCursor(clamped);
  }, [effectiveTeleprompterSession]);

  // Every word heard in a take moves its quiet clock on, and a stop phrase among the newest words ends it.
  const heardInTake = React.useCallback((teleprompter: RecordingTeleprompterSession, saying: string) => {
    if (saying === lastHeardTextRef.current) return;
    lastHeardTextRef.current = saying;
    lastHeardAtRef.current = Date.now();
    const phrase = heardStopPhrase(teleprompter, saying);
    if (phrase) setStopPhraseHeard(phrase);
  }, []);

  const startSpeechFollower = React.useCallback((teleprompter: RecordingTeleprompterSession) => {
    if (typeof WebSocket !== 'undefined' || hasNativeSpeechBridge()) {
      const stream = currentLiveRecording()?.stream;
      if (!stream) {
        setTeleprompterMode('Speech follower unavailable', true);
        return;
      }
      const context = listeningContext();
      recognitionBaseRef.current = teleprompterCursorRef.current;
      setTeleprompterMode('Listening to your words');
      const listener = listenForWords(
        () => currentLiveRecording()?.recorder?.state === 'recording',
        stream,
        context,
        (words) => {
          if (currentLiveRecording()?.recorder?.state !== 'recording') return;
          setHeard(words);
          const live = currentLiveRecording();
          if (live) {
            updateLiveRecording(live.session.recordingId, (recording) => {
              recording.heard = withoutLoops([words.final, words.hearing].filter(Boolean).join(' '));
            });
          }
          const saying = [words.final, words.hearing].filter(Boolean).join(' ').trim();
          heardInTake(teleprompter, saying);
          const spoken = saying.split(/\s+/).filter(Boolean);
          if (spoken.length > 0) {
            setTeleprompterCursor((current) => alignRecognizedWords(
              teleprompter, current, recognitionBaseRef.current, spoken,
            ));
          }
          const finalWords = words.final.trim().split(/\s+/).filter(Boolean);
          if (finalWords.length > 0) {
            const confirmed = alignRecognizedWords(
              teleprompter,
              confirmedTeleprompterCursorRef.current,
              recognitionBaseRef.current,
              finalWords,
            );
            confirmedTeleprompterCursorRef.current = confirmed;
            if (reachedScriptCompletion(teleprompter, confirmed)) setConfirmedSpeechComplete(true);
          }
        },
        (reason) => setTeleprompterMode(reason, true),
      );
      wordsRef.current = {
        ...listener,
        stop: () => { listener.stop(); void context?.close().catch(() => {}); },
        abort: () => { listener.abort(); void context?.close().catch(() => {}); },
      };
      return;
    }
    const Constructor = speechRecognitionConstructor();
    if (!Constructor) {
      setTeleprompterMode('Use Back and Forward', true);
      setMessage('This browser cannot provide live speech recognition. Recording still works, and the teleprompter can be nudged manually.');
      return;
    }

    const recognition = new Constructor();
    recognition.lang = teleprompter.speechLanguage;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognitionBaseRef.current = teleprompterCursorRef.current;
    restartRecognitionRef.current = true;

    recognition.onstart = () => setTeleprompterMode('Listening to your words');
    recognition.onresult = (event) => {
      // Recognition callbacks can arrive after pause or provider stop. They may
      // not advance the prompt or claim completion outside actively captured
      // media time.
      if (currentLiveRecording()?.recorder?.state !== 'recording') return;
      const heardWords: string[] = [];
      const finalWords: string[] = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript?.trim();
        if (!transcript) continue;
        heardWords.push(...transcript.split(/\s+/));
        if (result.isFinal === true) finalWords.push(...transcript.split(/\s+/));
      }
      if (heardWords.length === 0) return;
      heardInTake(teleprompter, heardWords.join(' '));
      const live = currentLiveRecording();
      if (live) {
        updateLiveRecording(live.session.recordingId, (recording) => {
          recording.heard = [heardBaseRef.current, finalWords.join(' ')].filter(Boolean).join(' ');
        });
      }
      setTeleprompterCursor((current) => alignRecognizedWords(
        teleprompter,
        current,
        recognitionBaseRef.current,
        heardWords,
      ));
      if (finalWords.length > 0) {
        const confirmed = alignRecognizedWords(
          teleprompter,
          confirmedTeleprompterCursorRef.current,
          confirmedTeleprompterCursorRef.current,
          finalWords,
        );
        confirmedTeleprompterCursorRef.current = confirmed;
        if (reachedScriptCompletion(teleprompter, confirmed)) setConfirmedSpeechComplete(true);
      }
    };
    recognition.onerror = (event) => {
      if (event.error === 'no-speech') {
        setTeleprompterMode('Listening: say the highlighted word', true);
        return;
      }
      if (event.error !== 'aborted') setTeleprompterMode('Speech follower reconnecting', true);
    };
    recognition.onend = () => {
      if (!restartRecognitionRef.current || currentLiveRecording()?.recorder?.state !== 'recording') return;
      recognitionBaseRef.current = teleprompterCursorRef.current;
      heardBaseRef.current = currentLiveRecording()?.heard ?? heardBaseRef.current;
      try {
        recognition.start();
      } catch {
        window.setTimeout(() => {
          try {
            recognition.start();
          } catch {
            setTeleprompterMode('Speech follower unavailable', true);
          }
        }, 350);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setTeleprompterMode('Speech follower unavailable', true);
    }
  }, [heardInTake, setTeleprompterMode]);

  React.useEffect(() => {
    const active = currentLiveRecording();
    if (
      active?.teleprompter?.followSpeech
      && active.recorder?.state === 'recording'
      && !recognitionRef.current
      && !wordsRef.current
    ) {
      startSpeechFollower(active.teleprompter);
    }
  }, [liveVersion, startSpeechFollower]);

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

  const stopWithReason = React.useCallback(async (reasonRef: string, sourceRef: string) => {
    const live = currentLiveRecording();
    const recorder = live?.recorder ?? null;
    if (!live) return;
    const claim = claimLiveRecordingStop(live.session.recordingId, {
      reasonRef,
      sourceRef,
      observedAtMs: Date.now(),
    });
    if (!claim.invokeProviderStop || !claim.recording) return;
    setStage('stopping');
    const journalWrite = writeCaptureJournal(captureJournal(claim.recording, 'stopping'));
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    try {
      await journalWrite;
    } catch (error) {
      setMessage(`Recording stopped, but its recovery journal could not be updated: ${plainError(error)}`);
    }
  }, []);

  // A recognized final word means the speaker has passed the end of the script.
  // The grace period lets the recognizer deliver its final matched token before
  // the recorder stops; a manual nudge to the last visible word does not claim
  // completion because the cursor remains inside the word list.
  React.useEffect(() => {
    if (stage !== 'recording' || !activeTeleprompterSession?.stopOnFinalWord || !confirmedSpeechComplete) return undefined;
    // Trillion: with a quiet time, the take goes on past the script's last word while the speaker keeps talking, and
    // stops once no new word has been heard for that long.
    const quietMs = activeTeleprompterSession.scriptEndQuietMs;
    if (quietMs > 0) {
      lastHeardAtRef.current = Math.max(lastHeardAtRef.current, Date.now());
      const watch = window.setInterval(() => {
        if (Date.now() - lastHeardAtRef.current < quietMs) return;
        window.clearInterval(watch);
        void stopWithReason(activeTeleprompterSession.completionReasonRefs.speech, 'speech-recognition:quiet-after-script');
      }, 200);
      return () => window.clearInterval(watch);
    }
    const graceMs = activeTeleprompterSession.completionGraceMs;
    const timeout = window.setTimeout(() => {
      void stopWithReason(activeTeleprompterSession.completionReasonRefs.speech, 'speech-recognition:final-results');
    }, graceMs);
    return () => window.clearTimeout(timeout);
  }, [activeTeleprompterSession, confirmedSpeechComplete, stage, stopWithReason]);

  // Trillion: a stop phrase heard ("I'm done") ends the take with its own reason, once the take has recorded for at
  // least its minimum speech time, so a phrase heard as it starts never ends a take with nothing kept.
  React.useEffect(() => {
    if (stage !== 'recording' || !activeTeleprompterSession || !stopPhraseHeard) return undefined;
    const startedAtMs = currentLiveRecording()?.session.startedAtMs ?? Date.now();
    const wait = Math.max(0, startedAtMs + activeTeleprompterSession.minimumSpeechMs - Date.now());
    const timeout = window.setTimeout(() => {
      void stopWithReason(activeTeleprompterSession.completionReasonRefs.phrase, 'speech-recognition:stop-phrase');
    }, wait);
    return () => window.clearTimeout(timeout);
  }, [activeTeleprompterSession, stopPhraseHeard, stage, stopWithReason]);

  const finishSession = React.useCallback(async (recordingId: string) => {
    const live = claimLiveRecordingFinalization(recordingId);
    if (!live) return;
    const session = live.session;
    await writeCaptureJournal(captureJournal(live, 'flushing'));
    updateLiveRecording(session.recordingId, (recording) => {
      recording.countdownValue = null;
    });
    clearAutoStopTimer();
    stopSpeechFollower();
    setCountdownValue(null);
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
      releaseLiveRecording(session.recordingId);
      setActiveTeleprompterSession(null);
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
    const playbackBlob = await readRecordedFileBlob(storedFileRef);
    const { sourceRef } = await saveRecordedFileArtifact({
      recordingId: session.recordingId,
      recordedFileId,
      mode: session.mode,
      mediaType: session.mediaType,
      recordedAt,
      bytes: await blobBytes(playbackBlob),
    });

    await saveRecordingState({
      recordingId: session.recordingId,
      mode: session.mode,
      state: 'stopped',
      observedAt: recordedAt,
      completionReason: live.completion?.reasonRef ?? completionReasonRef(live, 'providerEnd'),
    });
    const recordingLabel = defaultRecordingLabel(session.mode, recordedAtDate);
    await saveRecordedFile({
      recordingId: session.recordingId,
      label: recordingLabel,
      recordedFileId,
      mode: session.mode,
      mediaType: session.mediaType,
      byteLength: storedFileRef.byte_length,
      durationMs,
      recordedAt,
      storedFileRef,
      sourceRef,
      completionReasonRef: live.completion?.reasonRef ?? completionReasonRef(live, 'providerEnd'),
      completionObservedAt: live.completion ? new Date(live.completion.observedAtMs).toISOString() : recordedAt,
      artifactDisposition: live.completion?.reasonRef === live.completionReasonRefs.providerError
        ? 'saved-with-capture-error'
        : 'saved',
    });
    if (live.teleprompter?.subtitle.trim()) {
      await setRecordingSubtitle({
        recordedFileId,
        subtitle: live.teleprompter.subtitle,
      });
    }

    const playbackUrl = createPlaybackUrl(playbackBlob);
    setSavedRecording({
      recordingId: session.recordingId,
      recordedFileId,
      mode: session.mode,
      mediaType: session.mediaType,
      durationMs,
      playbackUrl,
      recordedAt,
      sourceRef,
    });
    await deleteCaptureJournal(session.recordingId);
    releaseLiveRecording(session.recordingId);
    setActiveTeleprompterSession(null);
    setStage('saved');
    setMessage(live.teleprompter?.completionLabel || 'Recording saved.');
    onRecordingSavedRef.current?.({ recordedFileId, durationMs, completionReasonRef: live.completion?.reasonRef ?? null });
  }, [clearAutoStopTimer, createPlaybackUrl, now, stopSpeechFollower]);

  const runSetupCheck = React.useCallback(async () => {
    invalidateSetupEvidence();
    setSetupChecking(true);
    recordDiagnostic('setup observation', 'opening preview stream for pre-recording checks');
    try {
      const report = await observeBrowserMediaSetup({ video: true, audio: true });
      setSetupCheckReport(report);
      // Successfully opening a browser video+audio stream proves capture.video.
      // This is runtime evidence from the sensor pass, not a static declaration.
      setAvailableCapabilities(['capture.video']);
      recordDiagnostic(
        'setup observation complete',
        `problems=${report.problems.length} | camera=${report.observations.camera_live.value} | audio=${report.observations.audio_live.value} | framing=${report.observations.framing.value}`,
      );
    } catch (error) {
      recordDiagnostic('setup observation failed', diagnosticErrorDetail(error));
      setSetupCheckReport(null);
      setAvailableCapabilities([]);
      setMessage(plainError(error));
    } finally {
      setSetupChecking(false);
    }
  }, [invalidateSetupEvidence, recordDiagnostic]);

  const evaluateReadiness = React.useCallback(async () => {
    if (!setupCheckReport || !effectiveTeleprompterSession?.sourcePlanId) return;
    setEvaluatingReadiness(true);
    setReadinessResult(null);
    const observations = readinessObservationsFromSetup({
      report: setupCheckReport,
      requirements: effectiveTeleprompterSession.requirements,
      claimReviewed,
      capturePermitted,
      operatorObservedAtMs: Date.now(),
    });
    // Reconstruct the evaluator's plan input from session DATA.
    const planForEvaluation = {
      id: effectiveTeleprompterSession.sourcePlanId,
      requirements: effectiveTeleprompterSession.requirements.map((requirement) => ({
        ...requirement,
        max_age_seconds: requirement.maxAgeSeconds,
        expected: true,
      })),
      capabilities: effectiveTeleprompterSession.planCapabilities,
    };
    recordDiagnostic('readiness evaluation', `capabilities=${availableCapabilities.join(',')} | observations=${Object.keys(observations).length}`);
    try {
      // The readiness decision is the do-work owner's pure evaluator, called directly with the plan and setup
      // evidence this screen already holds. No remote request is involved.
      const readiness = presentationReadinessFromObservations({
        plan: planForEvaluation,
        observations,
        capabilities: availableCapabilities,
        nowMs: Date.now(),
      });
      setReadinessResult(readiness);
      recordDiagnostic('readiness evaluation complete', `state=${readiness.state}`);
    } catch (error) {
      recordDiagnostic('readiness evaluation failed', diagnosticErrorDetail(error));
      setMessage(plainError(error));
    } finally {
      setEvaluatingReadiness(false);
    }
  }, [availableCapabilities, capturePermitted, claimReviewed, effectiveTeleprompterSession, recordDiagnostic, setupCheckReport]);

  const startRecording = React.useCallback(async (
    nextMode: CaptureDescriptorValue,
    options?: { teleprompterSession?: RecordingTeleprompterSession | null },
  ) => {
    const Constructor = mediaRecorderConstructor();
    const teleprompter = options?.teleprompterSession ?? null;
    if (currentLiveRecording()) {
      setMessage('A recording is already in progress. Stop it before starting another.');
      return;
    }
    const recordingId = createRecordVideoId('recording');
    clearAutoStopTimer();
    stopSpeechFollower();
    clearPlaybackUrl();
    setStage('requesting');
    setMode(nextMode);
    setSavedRecording(null);
    setMessage('');
    setElapsedMs(0);
    setActiveTeleprompterSession(teleprompter);
    setCountdownValue(null);
    setTeleprompterCursor(0);
    setTeleprompterMode(teleprompter?.statusLabel ?? 'Speech follower', false);
    setHeard({ final: '', hearing: '' });
    setWordsNote('');
    heardBaseRef.current = '';

    try {
      recordDiagnostic('recording request start', `recordingId=${recordingId} | mode=${nextMode} | ${recordingEnvironment()}`);
      if (!Constructor) throw new Error('This browser cannot record video here.');
      const requestedMediaType = mediaTypeForRecorder(nextMode);
      const session: RecordingSession = {
        recordingId,
        recordedFileId: createRecordVideoId('recorded-file'),
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
        ownerInstanceRef: `capture-owner:${createRecordVideoId('instance')}`,
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
        autoStopTimeout: null,
        silenceMonitorCleanup: null,
        completion: null,
        providerStopInvoked: false,
        countdownValue: null,
        teleprompter,
        completionReasonRefs: teleprompter?.completionReasonRefs ?? packageCompletionReasonRefs,
        heard: '',
      };

      // Reserve synchronously before the permission await. Otherwise two
      // mounted tabs can both acquire hardware before either becomes owner.
      if (!tryAdoptLiveRecording(live)) {
        setStage('idle');
        setMessage('A recording is already in progress. Stop it before starting another.');
        return;
      }
      await writeCaptureJournal(captureJournal(live, 'requesting'));

      const stream = await mediaStreamForMode(nextMode);
      if (live.cancelled || currentLiveRecording() !== live) {
        stopStream(stream);
        return;
      }
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
          const active = currentLiveRecording();
          void stopWithReason(
            completionReasonRef(active, 'providerEnd'),
            `media-track:${track.kind}:ended`,
          );
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
          const active = currentLiveRecording();
          if (active?.session === activeSession) {
            void writeCaptureJournal(captureJournal(active, active.phase));
          }
          return chunkRef;
        }).catch((error: unknown) => {
          activeSession.chunkFailures.set(sequence, diagnosticErrorDetail(error));
          throw error;
        });
        activeSession.chunkWrites.push(chunkWrite);
        void chunkWrite.catch(() => {
          const active = currentLiveRecording();
          void stopWithReason(completionReasonRef(active, 'providerError'), `chunk-store:sequence:${sequence}`);
        });
      };
      recorder.onstop = () => {
        const active = currentLiveRecording();
        if (active?.session.recordingId === session.recordingId && !active.completion) {
          claimLiveRecordingStop(session.recordingId, {
            reasonRef: completionReasonRef(active, 'providerEnd'),
            sourceRef: 'media-recorder:onstop',
            observedAtMs: Date.now(),
          });
        }
        void finishSession(session.recordingId).catch((error: unknown) => {
          void recordError(session.recordingId, session.mode, error);
        });
      };
      recorder.onerror = () => {
        const active = currentLiveRecording();
        void stopWithReason(completionReasonRef(active, 'providerError'), 'media-recorder:onerror');
      };

      if (teleprompter && teleprompter.countdownSeconds > 0) {
        setStage('countdown');
        updateLiveRecording(recordingId, (recording) => {
          recording.phase = 'countdown';
        });
        for (let remaining = teleprompter.countdownSeconds; remaining > 0; remaining -= 1) {
          setCountdownValue(remaining);
          updateLiveRecording(recordingId, (recording) => {
            recording.countdownValue = remaining;
          });
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          if (live.cancelled || currentLiveRecording() !== live) return;
        }
        setCountdownValue(null);
        updateLiveRecording(recordingId, (recording) => {
          recording.countdownValue = null;
        });
      }
      if (live.cancelled || currentLiveRecording() !== live) return;

      session.startedAtMs = Date.now();
      session.timing = beginActiveTime(session.startedAtMs);
      await saveRecordingState({
        recordingId,
        mode: nextMode,
        state: 'recording',
        observedAt: now().toISOString(),
      });
      recorder.start(1000);
      updateLiveRecording(recordingId, (recording) => {
        recording.phase = 'recording';
      });
      await writeCaptureJournal(captureJournal(live, 'recording'));
      recordDiagnostic('recording started', `recordingId=${recordingId} | mimeType=${recorder.mimeType || session.mediaType}`);
      setStage('recording');
      if (!teleprompter?.followSpeech && stream.getAudioTracks().length > 0) {
        const wordsContext = listeningContext();
        const listener = listenForWords(
          () => currentLiveRecording()?.recorder?.state === 'recording',
          stream,
          wordsContext,
          (words) => {
            setHeard(words);
            updateLiveRecording(recordingId, (recording) => { recording.heard = withoutLoops(words.final); });
          },
          setWordsNote,
        );
        // The words' own listening is let go with them, so a finished take holds no sound open.
        wordsRef.current = { ...listener, stop: () => { listener.stop(); void wordsContext?.close().catch(() => {}); }, abort: () => { listener.abort(); void wordsContext?.close().catch(() => {}); } };
      }
      if (teleprompter) {
        setMessage('Speak the highlighted word. The teleprompter scrolls when your speech is recognized, and you can nudge it manually if needed.');
        if (teleprompter.followSpeech) startSpeechFollower(teleprompter);
        if (teleprompter.autoStopSeconds > 0) {
          live.autoStopTimeout = window.setInterval(() => {
            const active = currentLiveRecording();
            if (!active || active.phase !== 'recording') return;
            if (activeDurationMs(active.session.timing, Date.now()) >= teleprompter.autoStopSeconds * 1000) {
              void stopWithReason(teleprompter.completionReasonRefs.duration, 'active-duration-clock');
            }
          }, 100);
        }
        live.silenceMonitorCleanup = startSilenceStopMonitor(stream, teleprompter, () => {
          void stopWithReason(teleprompter.completionReasonRefs.silence, 'audio-analyser:rms');
        }, (detail) => {
          setTeleprompterMode('Silence stop unavailable', true);
          setMessage(detail);
          void stopWithReason(teleprompter.completionReasonRefs.providerError, 'audio-analyser:unavailable');
        }, capturePolicy.maximumSampleGapMs);
      }
    } catch (error) {
      const adopted = currentLiveRecording();
      if (adopted && adopted.session.recordingId === recordingId) {
        stopStream(adopted.stream);
        adopted.stream = null;
        releaseLiveRecording(recordingId);
      }
      setCountdownValue(null);
      setActiveTeleprompterSession(null);
      if (isPermissionError(error)) {
        recordDiagnostic('recording awaits permission', diagnosticErrorDetail(error));
        setStage('idle');
        setAwaitingPermission(true);
        setPermissionState('denied-by-system');
        setMessage('');
        return;
      }
      await recordError(recordingId, nextMode, error);
    }
  }, [
    clearAutoStopTimer,
    clearPlaybackUrl,
    finishSession,
    now,
    recordDiagnostic,
    recordError,
    setTeleprompterMode,
    startSpeechFollower,
    stopWithReason,
    stopSpeechFollower,
    packageCompletionReasonRefs,
    capturePolicy,
  ]);

  const stopRecording = React.useCallback(() => {
    const live = currentLiveRecording();
    void stopWithReason(completionReasonRef(live, 'manual'), 'record-video:stop-control');
  }, [stopWithReason]);

  const pauseRecording = React.useCallback(() => {
    const live = currentLiveRecording();
    const recorder = live?.recorder ?? null;
    const session = live?.session ?? null;
    if (!recorder || recorder.state !== 'recording' || !session) return;
    recorder.pause();
    wordsRef.current?.pause();
    updateLiveRecording(session.recordingId, (recording) => {
      recording.phase = 'paused';
      recording.session.timing = pauseActiveTime(recording.session.timing, Date.now());
    });
    setStage('paused');
    void saveRecordingState({
      recordingId: session.recordingId,
      mode: session.mode,
      state: 'paused',
      observedAt: now().toISOString(),
    }).then(() => writeCaptureJournal(captureJournal(live, 'paused')))
      .catch((error: unknown) => void recordError(session.recordingId, session.mode, error));
  }, [now, recordError]);

  const resumeRecording = React.useCallback(() => {
    const live = currentLiveRecording();
    const recorder = live?.recorder ?? null;
    const session = live?.session ?? null;
    if (!recorder || recorder.state !== 'paused' || !session) return;
    recorder.resume();
    wordsRef.current?.resume();
    updateLiveRecording(session.recordingId, (recording) => {
      recording.phase = 'recording';
      recording.session.timing = resumeActiveTime(recording.session.timing, Date.now());
    });
    setStage('recording');
    void saveRecordingState({
      recordingId: session.recordingId,
      mode: session.mode,
      state: 'resumed',
      observedAt: now().toISOString(),
    }).then(() => writeCaptureJournal(captureJournal(live, 'recording')))
      .catch((error: unknown) => void recordError(session.recordingId, session.mode, error));
  }, [now, recordError]);

  const cancelRecording = React.useCallback(() => {
    const live = currentLiveRecording();
    if (!live) return;
    updateLiveRecording(live.session.recordingId, (recording) => {
      recording.cancelled = true;
    });
    if (live.recorder && live.recorder.state !== 'inactive') {
      void stopWithReason(completionReasonRef(live, 'cancel'), 'record-video:cancel-control');
      return;
    }
    const claim = claimLiveRecordingStop(live.session.recordingId, {
      reasonRef: completionReasonRef(live, 'cancel'),
      sourceRef: 'record-video:cancel-control',
      observedAtMs: Date.now(),
    });
    if (claim.accepted && claim.recording) {
      void writeCaptureJournal(captureJournal(claim.recording, 'stopping'))
        .then(() => finishSession(live.session.recordingId))
        .catch((error: unknown) => void recordError(live.session.recordingId, live.session.mode, error));
    }
  }, [finishSession, recordError, stopWithReason]);

  const savePickedFile = React.useCallback(async (file: LocalChosenFile) => {
    const importedAtDate = now();
    const importedAt = importedAtDate.toISOString();
    const nextMode = modeForLocalFile(file);
    const recordingId = createRecordVideoId('recording');
    const recordedFileId = createRecordVideoId('recorded-file');
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

    const playbackUrl = createPlaybackUrl(fileBlob);
    setActiveTeleprompterSession(null);
    setMode(nextMode);
    setSavedRecording({
      recordingId,
      recordedFileId,
      mode: nextMode,
      mediaType,
      durationMs: 0,
      playbackUrl,
      recordedAt: importedAt,
      sourceRef,
    });
    setStage('saved');
    setMessage(`${file.name} saved.`);
    recordDiagnostic('picked file saved', `recordedFileId=${recordedFileId} | bytes=${file.byteLength}`);
  }, [createPlaybackUrl, now, recordDiagnostic]);

  const openFiles = React.useCallback(async () => {
    setStage('requesting');
    setMessage('');
    setSavedRecording(null);
    recordDiagnostic('local file picker start', 'prompt=Choose recordings | multiple=yes | source=local-files');
    try {
      const files = await chooseLocalFiles({
        prompt: 'Choose recordings',
        multiple: true,
        allowedContentPrefixes: ['video/', 'audio/'],
        allowedExtensions: RECORDING_EXTENSIONS,
      });
      recordDiagnostic(
        files.length === 0 ? 'local file picker canceled' : 'local file picker selected',
        files.map(pickedFileDetail).join('; ') || '0 files',
      );
      if (files.length === 0) {
        setStage('idle');
        return;
      }

      setStage('saving');
      for (const file of files) {
        await savePickedFile(file);
      }
    } catch (error) {
      const recordingId = createRecordVideoId('recording');
      await recordError(recordingId, mode, error);
    }
  }, [mode, recordDiagnostic, recordError, savePickedFile]);

  const loadPageMedia = React.useCallback(async (recording: ListedRecording) => {
    if (!recording.storedFileRef) return;
    setLoadingPlaybackId(recording.id);
    try {
      const blob = await readRecordedFileBlob(recording.storedFileRef);
      const url = URL.createObjectURL(blob);
      if (listPlaybackUrlRef.current) URL.revokeObjectURL(listPlaybackUrlRef.current);
      listPlaybackUrlRef.current = url;
      setPageMedia({ id: recording.id, url });
    } catch (error) {
      recordDiagnostic('listed playback error', diagnosticErrorDetail(error));
    } finally {
      setLoadingPlaybackId(null);
    }
  }, [recordDiagnostic]);

  React.useEffect(() => {
    if (stage !== 'saved' || !savedRecording) return;
    setSelectedId(savedRecording.recordedFileId);
    setStage('idle');
    setMessage('');
  }, [savedRecording, stage]);

  // Zero-friction founder contract (L185/L083): when the origin already holds
  // the capture grant, the teleprompter session auto-starts with zero clicks,
  // exactly as before. When it does not (first open ever, or WebKit has no
  // answer), the surface shows ONE primary "Enable camera & microphone" button
  // instead of a dead auto-start error — the single irreducible gesture WebKit
  // demands, after which every future open auto-starts again.
  React.useEffect(() => {
    if (!teleprompterSession?.autoStart) return;
    // A staged session that has not passed readiness evaluation and received
    // exact human authorization never auto-starts. The operator sees the
    // setup path instead of an involuntary camera start.
    if (teleprompterSession.readinessState !== 'ready_to_authorize') return;
    if (teleprompterSession.authorizationState !== 'authorized') return;
    if (selectedId) return;
    if (stage !== 'idle') return;
    if (awaitingPermission) return;
    if (autoStartedSessionIdRef.current === teleprompterSession.sessionId) return;
    autoStartedSessionIdRef.current = teleprompterSession.sessionId;
    let cancelled = false;
    void (async () => {
      const permission = await capturePermissionState(teleprompterSession.captureMode);
      if (cancelled) return;
      if (permission === 'granted') {
        void startRecording(teleprompterSession.captureMode, { teleprompterSession });
        return;
      }
      setPermissionState(permission);
      setAwaitingPermission(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [awaitingPermission, selectedId, stage, startRecording, teleprompterSession]);

  // The shared broker performs the real media request inside this click and
  // returns that same stream to the recorder. There is no package-local prime
  // request and no second getUserMedia call.
  const primeAndStart = React.useCallback(async () => {
    const teleprompter = effectiveTeleprompterSession;
    const nextMode = teleprompter?.captureMode ?? mode;
    setMessage('');
    setStage('requesting');
    recordDiagnostic('capability permission request', `mode=${nextMode}`);
    setAwaitingPermission(false);
    void startRecording(nextMode, { teleprompterSession: teleprompter });
  }, [effectiveTeleprompterSession, mode, recordDiagnostic, startRecording]);

  const selectedRecordingId = selectedRecording?.id ?? null;
  const selectedStoredFileRef = selectedRecording?.storedFileRef ?? null;
  React.useEffect(() => {
    closePageMedia();
    if (!selectedRecordingId || !selectedStoredFileRef) return;
    void loadPageMedia({
      ...(selectedRecording as ListedRecording),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRecordingId, closePageMedia, loadPageMedia]);

  // Surfaces from the published catalog that declare they accept this
  // recording's material kind. Pure data matching — this package never names
  // a consumer package (L090: self-describing data, generic handler).
  const openWithSurfaces = React.useMemo(() => {
    if (!selectedRecording) return [] as SurfaceCatalogEntry[];
    const kind = recordingMaterialKind(selectedRecording);
    const seen = new Set<string>();
    return surfaceCatalog
      .filter((surface) => {
        // The catalog can carry duplicate rows for one surface while the
        // platform's twin-record defect stands — one surface id renders once.
        if (surface.disabled || !surface.acceptsMaterialKinds.includes(kind)) return false;
        if (seen.has(surface.id)) return false;
        seen.add(surface.id);
        return true;
      })
      .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
  }, [selectedRecording, surfaceCatalog]);

  const openRecordingWith = React.useCallback((surface: SurfaceCatalogEntry) => {
    if (!selectedRecording) return;
    const subject = admitPlaceableSurfaceSubject({
      display: {
        ...(selectedRecording.label ? { name: selectedRecording.label } : {}),
        ...(selectedRecording.mediaType ? { content_type: selectedRecording.mediaType } : {}),
        ...(selectedRecording.byteLength > 0 ? { byte_length: selectedRecording.byteLength } : {}),
      },
      content: {
        ...(selectedRecording.sourceRef ? { source_ref: selectedRecording.sourceRef } : {}),
        record_id: selectedRecording.id,
      },
    });
    emitPlaceableSurfaceIntent({
      id: surface.id,
      title: surface.label,
      materialTarget: surface.materialTarget,
      packageEntry: surface.packageEntry ?? null,
      surfaceInput: {
        ...(surface.surfaceInput ?? {}),
        subjectRef: { address: subject.ref.address },
      },
    });
  }, [selectedRecording]);

  const renameListedRecording = React.useCallback((recording: ListedRecording, label: string) => {
    void setRecordingName({ recordedFileId: recording.id, label })
      .catch((error: unknown) => {
        recordDiagnostic('rename error', diagnosticErrorDetail(error));
        setMessage('The new name could not be saved.');
      });
  }, [recordDiagnostic]);

  const subtitleListedRecording = React.useCallback((recording: ListedRecording, subtitle: string) => {
    void setRecordingSubtitle({ recordedFileId: recording.id, subtitle })
      .catch((error: unknown) => {
        recordDiagnostic('subtitle error', diagnosticErrorDetail(error));
        setMessage('The subtitle could not be saved.');
      });
  }, [recordDiagnostic]);

  const removeListedRecording = React.useCallback((recording: ListedRecording) => {
    if (pageMedia?.id === recording.id) closePageMedia();
    if (selectedId === recording.id) setSelectedId(null);
    void removeRecording({ recordedFileId: recording.id })
      .catch((error: unknown) => {
        recordDiagnostic('remove error', diagnosticErrorDetail(error));
        setMessage('The recording could not be removed.');
      });
  }, [closePageMedia, pageMedia, recordDiagnostic, selectedId]);

  const live = stage === 'recording';
  const paused = stage === 'paused';
  const countingDown = stage === 'countdown';
  const activeCapture = live || paused || countingDown;
  const focusActive = activeCapture;
  React.useEffect(() => {
    onCaptureActiveChange?.(focusActive);
    return () => onCaptureActiveChange?.(false);
  }, [focusActive, onCaptureActiveChange]);
  const processingCapture = stage === 'stopping' || stage === 'flushing' || stage === 'saving';
  const captureErrored = stage === 'recoverable-error' || stage === 'terminal-error';
  const captureBusy = stage === 'requesting' || processingCapture || countingDown;
  const teleprompterSegments = effectiveTeleprompterSession?.sentences.map((sentence) => sentence.text) ?? [];
  const teleprompterMeta = effectiveTeleprompterSession
    ? teleprompterMetaLabel(effectiveTeleprompterSession, teleprompterCursor)
    : '';
  const teleprompterProgress = effectiveTeleprompterSession
    ? teleprompterCursor / effectiveTeleprompterSession.words.length
    : 0;
  const captureTitle = effectiveTeleprompterSession?.title || 'Record video';
  const captureSubtitle = effectiveTeleprompterSession?.subtitle || 'Record a video or your voice, or pick a recording from your device.';
  const statusHeadline = countingDown
    ? `Starting in ${countdownValue ?? ''}`
    : activeCapture
      ? elapsedLabel(elapsedMs)
      : processingCapture
        ? stage === 'stopping' ? 'Stopping' : stage === 'flushing' ? 'Flushing media' : 'Saving'
        : 'Ready';

  // A recording's ⋯ menu: the app's own rows first (Share), then the part's: download it, open it with any screen that
  // takes a recording, start a new one, remove it. One shared action menu, so Remove rests quiet and turns red only
  // when pointed at, as every destructive row does.
  const selectedRecordingMenu = React.useMemo<RecordingMenuRow[]>(() => {
    if (!selectedRecording) return [];
    const openWith: ActionMenuItem[] = openWithSurfaces.map((surface) => ({ id: `open-with:${surface.id}`, label: surface.label, icon: 'AppWindow' }));
    return [
      ...recordingMenuRows.map((row) => ({ ...row, group: row.group ?? 'app' })),
      ...(pageMedia?.id === selectedRecording.id ? [{ id: 'download', label: 'Download', icon: 'Download', group: 'file' }] : []),
      ...(openWith.length ? [{ id: 'open-with', label: 'Open with', icon: 'SquareArrowOutUpRight', group: 'file', items: openWith }] : []),
      { id: 'new-recording', label: 'New recording', icon: 'Plus', group: 'new' },
      { id: 'remove', label: 'Remove', icon: 'Trash2', tone: 'destructive', confirm: 'Remove for good', group: 'remove' },
    ];
  }, [selectedRecording, openWithSurfaces, recordingMenuRows, pageMedia]);

  const runRecordingMenu = React.useCallback((id: string) => {
    const recording = selectedRecording;
    if (!recording) return;
    const own = recordingMenuRows.find((row) => row.id === id);
    if (own?.run) {
      own.run({ id: recording.id, label: recording.label, fileRef: recordingFileRef(recording), mediaType: recording.mediaType });
      return;
    }
    if (id === 'download' && pageMedia?.id === recording.id) void downloadAddress(pageMedia.url, downloadFileName(recording));
    else if (id === 'new-recording') setSelectedId(null);
    else if (id === 'remove') removeListedRecording(recording);
    else if (id.startsWith('open-with:')) {
      const surface = openWithSurfaces.find((one) => `open-with:${one.id}` === id);
      if (surface) openRecordingWith(surface);
    }
  }, [selectedRecording, recordingMenuRows, pageMedia, removeListedRecording, openWithSurfaces, openRecordingWith]);

  const capturePane = (
    <Container layout="vertical" gap="lg" padding="lg" overflow="y-auto" flex={1} className="min-w-0">
      <Container layout="horizontal" gap="md" justifyContent="between" alignItems="start" wrap>
        {/* Trillion: the title keeps room for itself (16rem) and the actions beside it wrap below, never over it. */}
        <Container layout="vertical" gap="xs" flex={1} className="min-w-0 basis-64">
          <Text variant="heading-xl">{captureTitle}</Text>
          {captureSubtitle !== captureTitle ? <Text variant="body" color="secondary">{captureSubtitle}</Text> : null}
          {stage === 'requesting' ? <Text variant="body-xs" color="faint">{(effectiveTeleprompterSession?.captureMode ?? mode) === 'audio' ? 'Allow microphone access to continue.' : 'Allow camera and microphone access to continue.'}</Text> : null}
          {paused ? <Text variant="body-xs" color="faint">Paused</Text> : null}
          {captureErrored ? <Text variant="body" color="error">{message}</Text> : null}
        </Container>
        {!activeCapture && !processingCapture && captureActions ? captureActions : null}
        {activeCapture && liveCaptureActions ? liveCaptureActions : null}
        <Container layout="vertical" gap="none" className="shrink-0 text-right">
          <Text variant="heading-lg" tabular>
            {statusHeadline}
          </Text>
          {effectiveTeleprompterSession && activeCapture ? (
            <Text variant="body-xs" color={teleprompterStatus.problem ? 'warning' : 'faint'}>
              {teleprompterStatus.label}
            </Text>
          ) : null}
        </Container>
      </Container>

      {effectiveTeleprompterSession && activeCapture ? (
        <div className="relative min-h-[32rem] overflow-hidden rounded-[28px] border border-[var(--border-primary)] bg-[var(--black-rich)] shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
          <MediaFrame
            stream={currentLiveRecording()?.stream ?? null}
            mediaType="video/webm"
            label="Camera preview"
            fill
            autoPlay
            muted
            mirrored
            className="absolute inset-0 h-full w-full"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(2,4,8,0.36),rgba(2,4,8,0.68))]" />
          <div className="absolute left-1/2 top-[8%] z-10 w-[min(1040px,88%)] -translate-x-1/2">
            <CaptionScroll
              mirrored={effectiveTeleprompterSession.mirrorScript}
              segments={teleprompterSegments}
              activeWordIndex={teleprompterCursor}
              spokenWordCount={teleprompterCursor}
              progress={teleprompterProgress}
              statusLabel={teleprompterStatus.label}
              metaLabel={teleprompterMeta}
              showNudges={effectiveTeleprompterSession.allowManualNudge}
              onBack={effectiveTeleprompterSession.allowManualNudge ? () => moveTeleprompterCursor(teleprompterCursor - 1) : undefined}
              onForward={effectiveTeleprompterSession.allowManualNudge ? () => moveTeleprompterCursor(teleprompterCursor + 1) : undefined}
            />
          </div>
          {countdownValue !== null ? (
            <div className="absolute inset-0 z-20 grid place-items-center bg-[rgba(2,3,6,0.64)] text-[min(34vw,240px)] font-black text-white">
              {countdownValue}
            </div>
          ) : null}
        </div>
      ) : null}
      {effectiveTeleprompterSession && activeCapture ? (
        <LiveWaveform stream={currentLiveRecording()?.stream ?? null} active={live} frame="flat" edgeFade aria-label="Live recording waveform" />
      ) : (
        <>
          {activeCapture || processingCapture ? (
            mode === 'video' ? (
              <>
                <div className="relative min-h-[24rem] overflow-hidden rounded-[24px] border border-[var(--border-primary)] bg-[var(--black-rich)]">
                  <MediaFrame
                    stream={currentLiveRecording()?.stream ?? null}
                    mediaType="video/webm"
                    label="Camera preview"
                    fill
                    autoPlay
                    muted
                    mirrored
                    className="h-full min-h-[24rem] w-full"
                  />
                  {activeCapture ? (
                    <Container position="absolute" inset="0" layout="vertical" justifyContent="end" padding="md" zIndex="10">
                      <Container background="overlay" rounded="lg" padding="md" aria-label="What you said" aria-live="polite">
                        {heard.final || heard.hearing ? (
                          <Text as="p" variant="body-lg" wrap="preserve">
                            {shownFinal}{shownFinal && heard.hearing ? ' ' : ''}<Text as="span" variant="body-lg" color="muted">{heard.hearing}</Text>
                          </Text>
                        ) : <Text as="p" variant="body" color="muted">{paused ? 'Paused' : wordsNote || 'Listening…'}</Text>}
                      </Container>
                    </Container>
                  ) : null}
                </div>
                <LiveWaveform stream={currentLiveRecording()?.stream ?? null} active={live} processing={processingCapture} frame="flat" edgeFade aria-label="Live recording waveform" />
              </>
            ) : (
              <>
                <LiveWaveform stream={currentLiveRecording()?.stream ?? null} active={live} processing={processingCapture} frame="flat" edgeFade aria-label="Live recording waveform" />
                {activeCapture && (heard.final || heard.hearing) ? (
                  <Text as="p" variant="body-lg" wrap="preserve" aria-label="What you said" aria-live="polite">
                    {shownFinal}{shownFinal && heard.hearing ? ' ' : ''}<Text as="span" variant="body-lg" color="muted">{heard.hearing}</Text>
                  </Text>
                ) : null}
              </>
            )
          ) : null}
          {!activeCapture && !processingCapture ? (
            <div className="rounded-[24px] border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] px-6 py-10 text-center">
              <Text variant="body" color="secondary">
                Record a video or your voice, or pick a recording from your device.
              </Text>
            </div>
          ) : null}
        </>
      )}

      {awaitingPermission && !activeCapture && !processingCapture && !captureErrored ? (
        recordVideoCapabilityPermissionForMode(effectiveTeleprompterSession?.captureMode ?? mode) ? (
          <CapabilityPermissionPrompt
            descriptor={recordVideoCapabilityPermissionForMode(effectiveTeleprompterSession?.captureMode ?? mode)!}
            state={permissionState === 'granted' ? 'undetermined' : permissionState}
            requesting={stage === 'requesting'}
            onRequest={() => void primeAndStart()}
          />
        ) : null
      ) : null}

      {effectiveTeleprompterSession
        && !activeCapture
        && !processingCapture
        && !captureErrored
        && effectiveTeleprompterSession.readinessState !== 'ready_to_authorize' ? (
        <div className="rounded-[24px] border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] px-6 py-6">
          <Text variant="body" color="primary">Setup check required</Text>
          <Text variant="body-xs" color="secondary">
            This recording needs independent sensor checks before it can be authorized.
          </Text>
          <Container layout="horizontal" gap="sm" wrap alignItems="center" className="mt-3">
            <Button
              variant="secondary"
              loading={setupChecking}
              onClick={() => runSetupCheck()}
            >
              <Icon icon={Mic} size="xs" />
              {setupChecking ? 'Checking setup…' : 'Check setup'}
            </Button>
          </Container>
          {setupCheckReport ? (
            <Container layout="vertical" gap="xs" className="mt-3">
              {setupCheckReport.problems.length === 0 ? (
                <>
                  <Text variant="body-xs" color="primary">All sensor checks passed.</Text>
                  <Container layout="vertical" gap="xs" className="mt-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={claimReviewed}
                        onChange={(event) => setClaimReviewed(event.target.checked)}
                      />
                      <span>I reviewed the actual claims and wording in this script.</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={capturePermitted}
                        onChange={(event) => setCapturePermitted(event.target.checked)}
                      />
                      <span>I'm ready to record this take. Posting it is a separate choice.</span>
                    </label>
                  </Container>
                  {claimReviewed && capturePermitted ? (
                    <Button
                      variant="secondary"
                      loading={evaluatingReadiness}
                      onClick={() => evaluateReadiness()}
                      className="mt-2"
                    >
                      {evaluatingReadiness ? 'Checking if ready…' : 'Check if ready'}
                    </Button>
                  ) : null}
                  {readinessResult ? (
                    <Text variant="body-xs" color={readinessResult.state === 'ready_to_authorize' ? 'primary' : 'error'}>
                      {readinessResult.state === 'ready_to_authorize'
                        ? 'Ready to record. Camera and microphone access applies only to this take.'
                        : `Not ready: ${(readinessResult.problems ?? []).length} problem(s).`}
                    </Text>
                  ) : null}
                </>
              ) : (
                setupCheckReport.problems.map((problem) => (
                  <Text key={problem.key} variant="body-xs" color="error">
                    {sanitizeErrorText(problem.detail, 'One setup check needs attention.')}
                  </Text>
                ))
              )}
            </Container>
          ) : null}
        </div>
      ) : null}

      <Container layout="horizontal" gap="sm" wrap alignItems="center">
        {countingDown ? (
          <Button variant="ghost" onClick={cancelRecording}>Cancel</Button>
        ) : activeCapture ? (
          <>
            <Button variant="primary" onClick={stopRecording}>
              <Icon icon={Square} size="xs" fill="currentColor" />
              Stop
            </Button>
            {paused ? (
              <Button variant="secondary" onClick={resumeRecording}>
                <Icon icon={Play} size="xs" />
                Resume
              </Button>
            ) : (
              <Button variant="secondary" onClick={pauseRecording}>
                <Icon icon={Pause} size="xs" />
                Pause
              </Button>
            )}
            <Button variant="ghost" onClick={cancelRecording}>Cancel</Button>
          </>
        ) : awaitingPermission ? null : (
          <>
            {/* Trillion: record a video or your voice alone, with or without a script. */}
            <SegmentedControl
              ariaLabel="What to record"
              items={[{ id: 'video', label: 'Video' }, { id: 'audio', label: 'Voice' }]}
              value={mode}
              onValueChange={(value) => setMode(value)}
            />
            <Button
              variant="primary"
              loading={stage === 'requesting'}
              disabled={captureBusy}
              onClick={() => startRecording(mode, { teleprompterSession: effectiveTeleprompterSession })}
            >
              Start recording
            </Button>
            <Button variant="ghost" disabled={captureBusy} onClick={() => openFiles()}>
              Pick a recording
            </Button>
          </>
        )}
      </Container>

      {message.trim() && !captureErrored ? (
        <Text variant="body-xs" color="faint">{message}</Text>
      ) : null}

      {stage === 'recoverable-error' && currentLiveRecording()?.phase === 'recoverable-error' ? (
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

  const showCapture = (
    (!selectedRecording && Boolean(effectiveTeleprompterSession))
    || activeCapture
    || stage === 'requesting'
    || processingCapture
    || captureErrored
  );

  return (
    // Trillion: in a pane narrower than 40rem the recording keeps the pane's width and the recordings list sits under
    // it, as a phone's recorder does; wider, the list sits beside it as the package draws it.
    <Container height="full" minHeight="0" className="@container">
    <Container layout="vertical" gap="none" height="full" minHeight="0" className="overflow-y-auto @[40rem]:flex-row @[40rem]:overflow-visible">
      <Container minHeight="0" className="order-last shrink-0 @[40rem]:order-first @[40rem]:h-full">
      <AppSidebar
        instanceId="record-video-recordings"
        presentation="embedded"
        sections={recordingSections}
        currentSelectionId={selectedId ?? ''}
        onNavigate={setSelectedId}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search recordings"
        searchAriaLabel="Search recordings"
        emptyContent={<Text variant="body" color="muted">{search ? 'No matching recordings' : 'No recordings yet'}</Text>}
        onItemAction={(item, actionId) => {
          const recording = recordings.find((r) => r.id === (item.viewId ?? item.id));
          if (recording && actionId === 'remove') removeListedRecording(recording);
        }}
      />
      </Container>

      <Container layout="vertical" gap="none" flex={1} className="min-w-0 shrink-0 @[40rem]:h-full @[40rem]:shrink">
        {showCapture || !selectedRecording ? (
          capturePane
        ) : (
          <RecordingPage
            recording={selectedRecording}
            completionReasonRefs={packageCompletionReasonRefs}
            enrichment={enrichmentByRecording.get(selectedRecording.id) ?? null}
            playbackUrl={pageMedia && pageMedia.id === selectedRecording.id ? pageMedia.url : null}
            loadingPlayback={loadingPlaybackId === selectedRecording.id}
            menuRows={selectedRecordingMenu}
            onMenuAction={runRecordingMenu}
            onRename={(label) => renameListedRecording(selectedRecording, label)}
            onSubtitle={(subtitle) => subtitleListedRecording(selectedRecording, subtitle)}
            pageStarter={pageScreens}
            surfaceListAddressLabel={surfaceListAddressLabel}
            previewStore={previewStore}
            layoutEntry={recordingPageLayoutEntry}
            publishedRecordsEntry={publishedRows}
            placeableSurfaceListEntry={recordingWorkspaceSurfaces}
          />
        )}
      </Container>
    </Container>
    </Container>
  );
}
