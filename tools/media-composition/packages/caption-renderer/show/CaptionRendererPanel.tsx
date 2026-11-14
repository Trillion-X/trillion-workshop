import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Download, ExternalLink, FolderOpen, Play, Settings2, SlidersHorizontal } from 'lucide-react';

import { Button } from '@/packages/ui/show/button';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Input } from '@/packages/ui/show/input';
import { Text } from '@/packages/ui/show/text';
import { chooseLocalFiles, readLocalFile, type LocalChosenFile } from '@/packages/local-files/do-work/choose-local-files';
import { chooseLocalFolder } from '@/packages/local-files/do-work/choose-local-folder';
import { revealLocalPath } from '@/packages/local-files/do-work/reveal-local-path';
import {
  DEFAULT_CAPTION_PRESET_ID,
  captionPresetName,
  isRecord,
  readCaptionOutputRecords,
  readCaptionPresets,
} from '@/packages/caption-renderer/read-data/caption-renderer-records';
import {
  captionTimingFromJson,
  readCaptionTranscriptionQueue,
  readCaptionTranscriptionWorkflowOutcome,
} from '@/packages/caption-renderer/read-data/caption-timing-view';
import type {
  CaptionMediaSource,
  CaptionOutputRecord,
  CaptionRenderSettings,
  CaptionTiming,
  CaptionTranscriptionQueueItem,
} from '@/packages/caption-renderer/read-data/caption-renderer-types';
import {
  buildCaptionRenderInvocation,
  createCaptionRenderRequestId,
  readCaptionRenderWorkflowOutcome,
  readFileAsByteArray,
  runCaptionRender,
} from '@/packages/caption-renderer/do-work/run-caption-render';
import {
  createCaptionTranscriptionRequestId,
  prepareCaptionAudioTranscriptionRequest,
  readCaptionAudioTranscriptionOutcomeRecords,
  requestCaptionAudioTranscription,
  submitPreparedCaptionAudioTranscriptionRequest,
} from '@/packages/caption-renderer/do-work/request-caption-transcription';
import { CaptionDropStep, type CaptionDiagnosticEntry, type CaptionDropStepItem } from '@/packages/caption-renderer/show/CaptionDropStep';
import { CaptionPreview } from '@/packages/caption-renderer/show/CaptionPreview';
import { visibleCaptionError } from '@/packages/caption-renderer/show/caption-visible-error';

const DEFAULT_SETTINGS: CaptionRenderSettings = {
  presetId: DEFAULT_CAPTION_PRESET_ID,
  fps: 30,
  quality: 90,
  concurrency: 2,
  audioOffsetSeconds: -0.1,
};

type LocalCaptionJobPhase = 'queued' | 'preparing' | 'staging' | 'submitting' | 'accepted' | 'error';
type RenderStatus = 'idle' | 'rendering' | 'ready' | 'error';

type LocalCaptionJob = {
  requestId: string;
  fileName: string;
  byteLength: number;
  source: CaptionMediaSource | null;
  phase: LocalCaptionJobPhase;
  startedAtMs: number;
  acceptedAtMs: number | null;
  mediaDurationSeconds: number | null | undefined;
  localTiming: CaptionTiming | null;
  sending: boolean;
  errorMessage: string | null;
};

type CaptionQueueViewItem = CaptionTranscriptionQueueItem & {
  phase?: LocalCaptionJobPhase;
  startedAtMs?: number;
  acceptedAtMs?: number | null;
  mediaDurationSeconds?: number | null;
  sending: boolean;
  selected: boolean;
};

type CaptionAssetInput = {
  displayName: string;
  byteLength: number;
  contentType: string;
  loadSource: () => Promise<CaptionMediaSource>;
};

const CAPTION_ASSET_EXTENSIONS = [
  'aac',
  'aif',
  'aiff',
  'flac',
  'm4a',
  'mov',
  'mp3',
  'mp4',
  'mpeg',
  'mpg',
  'ogg',
  'wav',
  'webm',
];

const MEDIA_DURATION_DETECTION_TIMEOUT_MS = 2_500;
const TRANSCRIPTION_OUTCOME_POLL_INTERVAL_MS = 1_500;
const OUTPUT_FOLDER_STORAGE_KEY = 'bitfield-studio:caption-renderer:last-output-folder';
const DEFAULT_OUTPUT_FOLDER = '~/Downloads';

function elapsedText(startedAtMs: number | null | undefined, nowMs: number): string {
  if (!startedAtMs) return 'elapsed time unavailable';
  const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s elapsed`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s elapsed` : `${minutes}m elapsed`;
}

function durationText(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function queueDetail(item: CaptionQueueViewItem, nowMs: number): string {
  if (item.errorMessage) return 'Needs another try';
  if (item.timing) return `${item.timing.preview.count} captions ready`;
  if (item.phase === 'preparing') return 'Reading the selected file';
  if (item.phase === 'staging') return 'Saving audio in engine storage';
  if (item.phase === 'submitting') return 'Submitting the caption job';
  if (item.phase === 'accepted') {
    const mediaLength = typeof item.mediaDurationSeconds === 'number' ? `${durationText(item.mediaDurationSeconds)} audio` : 'Audio queued';
    return `${mediaLength} · Waiting for captions · ${elapsedText(item.acceptedAtMs ?? item.startedAtMs, nowMs)}`;
  }
  if (item.sending) return 'Uploading into the work queue';
  if (item.requestedAt) return `Waiting for finished captions · ${elapsedText(Date.parse(item.requestedAt), nowMs)}`;
  return 'Waiting for finished captions';
}

function diagnosticErrorDetail(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function assetInputSummary(inputs: CaptionAssetInput[]): string {
  if (inputs.length === 0) return '0 files';
  return inputs.map((input) => `${input.displayName} (${input.contentType || 'unknown type'}, ${input.byteLength} bytes)`).join('; ');
}

function captionOutputRecordKey(record: CaptionOutputRecord, fallback: number): string {
  const maybeRecord = record as unknown;
  if (isRecord(maybeRecord) && typeof maybeRecord.metadata_address === 'string') return maybeRecord.metadata_address;
  if (isRecord(maybeRecord) && typeof maybeRecord.output_integrity_hash === 'string') return maybeRecord.output_integrity_hash;
  const processResult = isRecord(maybeRecord) && isRecord(maybeRecord.process_result) ? maybeRecord.process_result : null;
  const outputs = Array.isArray(processResult?.outputs) ? processResult.outputs : [];
  const firstOutput = outputs.find((output): output is Record<string, unknown> => isRecord(output));
  if (typeof firstOutput?.integrity_hash === 'string') return firstOutput.integrity_hash;
  if (typeof firstOutput?.chunk_manifest_hash === 'string') return firstOutput.chunk_manifest_hash;
  return `caption-output:${fallback}`;
}

function mergeCaptionOutputRecords(primary: CaptionOutputRecord[], secondary: CaptionOutputRecord[]): CaptionOutputRecord[] {
  const seen = new Set<string>();
  return [...primary, ...secondary].filter((record, index) => {
    const key = captionOutputRecordKey(record, index);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readStoredOutputFolder(): string {
  if (typeof window === 'undefined') return DEFAULT_OUTPUT_FOLDER;
  try {
    return window.localStorage.getItem(OUTPUT_FOLDER_STORAGE_KEY) || DEFAULT_OUTPUT_FOLDER;
  } catch {
    return DEFAULT_OUTPUT_FOLDER;
  }
}

function rememberOutputFolder(path: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(OUTPUT_FOLDER_STORAGE_KEY, path);
  } catch {
    // Folder memory is convenience only; render output still uses the chosen path.
  }
}

function folderLabel(path: string): string {
  if (path === DEFAULT_OUTPUT_FOLDER || path.endsWith('/Downloads')) return 'Downloads';
  return path.split('/').filter(Boolean).pop() ?? path;
}

function fileBaseName(fileName: string | null | undefined): string {
  const source = (fileName ?? 'caption-video').replace(/\.[^.]+$/, '').trim() || 'caption-video';
  return source.replace(/[/:\\]/g, '-');
}

function captionVideoOutputPath(folder: string, sourceFileName: string | null | undefined): string {
  return `${folder.replace(/\/+$/, '')}/${fileBaseName(sourceFileName)} captioned.mp4`;
}

function localOutputPathFromRecord(record: CaptionOutputRecord | null | undefined): string | null {
  const value = record as unknown;
  if (isRecord(value) && typeof value.local_output_path === 'string') return value.local_output_path;
  if (isRecord(value) && typeof value.requested_output_path === 'string') return value.requested_output_path;
  return null;
}

function bytesLabel(bytes: number | null | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function outputByteLengthFromRecord(record: CaptionOutputRecord | null | undefined): number | null {
  const value = record as unknown;
  if (isRecord(value) && typeof value.local_output_byte_len === 'number') return value.local_output_byte_len;
  const processResult = isRecord(value) && isRecord(value.process_result) ? value.process_result : null;
  const outputs = Array.isArray(processResult?.outputs) ? processResult.outputs : [];
  const firstOutput = outputs.find((output): output is Record<string, unknown> => isRecord(output));
  return typeof firstOutput?.byte_len === 'number' ? firstOutput.byte_len : null;
}

function revokeObjectUrl(url: string | null) {
  if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

async function detectMediaDurationSeconds(source: CaptionMediaSource): Promise<number | null> {
  if (source.kind !== 'inline') return null;
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  const contentType = source.contentType ?? '';
  if (!contentType.startsWith('audio/') && !contentType.startsWith('video/')) return null;

  const bytes = source.bytes instanceof Uint8Array ? source.bytes : Uint8Array.from(source.bytes);
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: contentType || 'application/octet-stream' }));

  return new Promise((resolve) => {
    const media = document.createElement(contentType.startsWith('video/') ? 'video' : 'audio');
    let settled = false;
    const settle = (value: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      media.removeAttribute('src');
      revokeObjectUrl(objectUrl);
      resolve(value);
    };
    const timeout = window.setTimeout(() => settle(null), MEDIA_DURATION_DETECTION_TIMEOUT_MS);
    media.preload = 'metadata';
    media.onloadedmetadata = () => {
      settle(Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null);
    };
    media.onerror = () => settle(null);
    media.src = objectUrl;
    media.load();
  });
}

function browserFileAssetInput(file: File): CaptionAssetInput {
  return {
    displayName: file.name,
    byteLength: file.size,
    contentType: file.type || 'application/octet-stream',
    loadSource: async () => ({
      kind: 'inline',
      bytes: await readFileAsByteArray(file),
      displayName: file.name,
      contentType: file.type || 'application/octet-stream',
      byteLength: file.size,
    }),
  };
}

function localFileAssetInput(file: LocalChosenFile): CaptionAssetInput {
  return {
    displayName: file.name,
    byteLength: file.byteLength,
    contentType: file.contentType,
    loadSource: async () => {
      // The picker is asked for metadata only (`includeBytes: false`) so a large media
      // choice stays instant; the bytes are read here, when this one file is queued,
      // through the same `local.files` owner the picker used.
      const bytes = file.bytes ?? (file.path ? (await readLocalFile(file.path)).bytes : undefined);
      if (!bytes) throw new Error(`Selected local file has no readable source: ${file.name}`);
      return {
        kind: 'inline',
        bytes,
        displayName: file.name,
        contentType: file.contentType || 'application/octet-stream',
        byteLength: file.byteLength,
      };
    },
  };
}

export function CaptionRendererPanel() {
  const publishedRecords = useBitfieldData('published-records');
  const evidenceRows = useBitfieldData('caption-renderer:contentMediaEvidence');
  const presets = useMemo(() => readCaptionPresets(publishedRecords), [publishedRecords]);
  const outputs = useMemo(() => readCaptionOutputRecords(publishedRecords), [publishedRecords]);
  const evidenceQueue = useMemo(() => readCaptionTranscriptionQueue(evidenceRows), [evidenceRows]);

  const [settings, setSettings] = useState<CaptionRenderSettings>(DEFAULT_SETTINGS);
  const [localJobs, setLocalJobs] = useState<LocalCaptionJob[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [manualTiming, setManualTiming] = useState<CaptionTiming | null>(null);
  const [localOutputs, setLocalOutputs] = useState<CaptionOutputRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [renderStatus, setRenderStatus] = useState<RenderStatus>('idle');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [outputFolder, setOutputFolder] = useState(readStoredOutputFolder);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [lastRenderedPath, setLastRenderedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setDiagnostics] = useState<CaptionDiagnosticEntry[]>([]);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const diagnosticSequenceRef = useRef(1);
  const outcomePollsInFlightRef = useRef(new Set<string>());
  const videoPreviewUrlRef = useRef<string | null>(null);

  useEffect(() => () => {
    revokeObjectUrl(videoPreviewUrlRef.current);
  }, []);

  function recordDiagnostic(event: string, detail: string) {
    const entry = {
      id: diagnosticSequenceRef.current,
      at: new Date().toISOString(),
      event,
      detail,
    };
    diagnosticSequenceRef.current += 1;
    console.info(`[caption-renderer] ${entry.event}`, entry.detail);
    setDiagnostics((current) => [...current.slice(-79), entry]);
  }

  const queueItems = useMemo<CaptionQueueViewItem[]>(() => {
    const evidenceById = new Map(evidenceQueue.map((item) => [item.requestId, item]));
    const merged = localJobs.map((local) => {
      const evidence = evidenceById.get(local.requestId);
      evidenceById.delete(local.requestId);
      return {
        requestId: local.requestId,
        fileName: local.fileName,
        byteLength: evidence?.byteLength ?? local.byteLength,
        source: local.source ?? evidence?.source ?? null,
        timing: local.localTiming ?? evidence?.timing ?? null,
        errorMessage: local.errorMessage ?? evidence?.errorMessage ?? null,
        requestedAt: evidence?.requestedAt,
        completedAt: evidence?.completedAt,
        phase: local.errorMessage ? 'error' : (local.localTiming ?? evidence?.timing) ? undefined : local.phase,
        startedAtMs: local.startedAtMs,
        acceptedAtMs: local.acceptedAtMs,
        mediaDurationSeconds: local.mediaDurationSeconds,
        sending: local.sending,
        selected: false,
      };
    });
    return [
      ...merged,
      ...Array.from(evidenceById.values()).map((item) => ({
        ...item,
        sending: false,
        selected: false,
      })),
    ];
  }, [evidenceQueue, localJobs]);

  const hasInFlightCaptionJob = queueItems.some((item) => !item.timing && !item.errorMessage);
  useEffect(() => {
    if (!hasInFlightCaptionJob) return undefined;
    const timer = window.setInterval(() => setClockMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasInFlightCaptionJob]);

  const selectedQueueItem = queueItems.find((item) => item.requestId === selectedRequestId)
    ?? queueItems.find((item) => item.timing)
    ?? queueItems[0]
    ?? null;
  const effectiveAudio = selectedQueueItem?.source ?? null;
  const effectiveTiming = manualTiming ?? selectedQueueItem?.timing ?? null;
  const canRender = Boolean(effectiveAudio && effectiveTiming && settings.presetId);
  const transcribing = queueItems.some((item) => !item.timing && !item.errorMessage);
  const visibleError = visibleCaptionError(error);
  const visibleOutputs = useMemo(() => mergeCaptionOutputRecords(localOutputs, outputs), [localOutputs, outputs]);
  const latestOutputRecord = visibleOutputs[0] ?? null;
  const selectedPreset = presets.find((preset) => preset.preset_id === settings.presetId) ?? presets[0];
  const plannedOutputPath = captionVideoOutputPath(outputFolder, selectedQueueItem?.fileName);
  const verifiedOutputPath = lastRenderedPath;
  const verifiedOutputRecord = verifiedOutputPath
    ? visibleOutputs.find((record) => localOutputPathFromRecord(record) === verifiedOutputPath) ?? latestOutputRecord
    : null;
  const verifiedOutputBytes = outputByteLengthFromRecord(verifiedOutputRecord);
  const dropItems = queueItems.map<CaptionDropStepItem>((item) => ({
    id: item.requestId,
    fileName: item.fileName,
    byteLength: item.byteLength,
    detail: queueDetail(item, clockMs),
    ready: Boolean(item.timing),
    selected: item.requestId === selectedQueueItem?.requestId,
    error: visibleCaptionError(item.errorMessage),
  }));

  async function requestTiming(source: CaptionMediaSource, requestId = createCaptionTranscriptionRequestId()) {
    setError(null);
    recordDiagnostic('caption timing request start', `requestId=${requestId} | source=${source.displayName ?? source.kind}`);
    try {
      await requestCaptionAudioTranscription({ requestId, audio: source });
      recordDiagnostic('caption timing request accepted', `requestId=${requestId}`);
    } catch (transcriptionError) {
      const detail = diagnosticErrorDetail(transcriptionError);
      recordDiagnostic('caption timing request failed', detail);
      setError(transcriptionError instanceof Error ? transcriptionError.message : String(transcriptionError));
    }
  }

  function updateLocalJob(requestId: string, update: Partial<LocalCaptionJob>) {
    setLocalJobs((current) => current.map((job) => job.requestId === requestId ? { ...job, ...update } : job));
  }

  function applyCaptionWorkflowOutcome(requestId: string, outcome: ReturnType<typeof readCaptionTranscriptionWorkflowOutcome>, source: CaptionMediaSource | null) {
    if (outcome?.timing) {
      recordDiagnostic('transcription result received', `requestId=${requestId} | captions=${outcome.timing.preview.count}`);
      updateLocalJob(requestId, {
        ...(source ? { source } : {}),
        phase: 'accepted',
        acceptedAtMs: Date.now(),
        localTiming: outcome.timing,
        sending: false,
        errorMessage: null,
      });
      return true;
    }
    if (outcome?.errorMessage) {
      recordDiagnostic('transcription error received', `requestId=${requestId} | ${outcome.errorMessage}`);
      updateLocalJob(requestId, {
        ...(source ? { source } : {}),
        phase: 'error',
        acceptedAtMs: Date.now(),
        sending: false,
        errorMessage: outcome.errorMessage,
      });
      return true;
    }
    return false;
  }

  async function readAndApplyDurableTranscriptionOutcome(requestId: string, source: CaptionMediaSource | null) {
    if (outcomePollsInFlightRef.current.has(requestId)) return false;
    outcomePollsInFlightRef.current.add(requestId);
    try {
      const outcomeRecords = await readCaptionAudioTranscriptionOutcomeRecords(requestId);
      return applyCaptionWorkflowOutcome(
        requestId,
        readCaptionTranscriptionWorkflowOutcome(outcomeRecords, requestId),
        source,
      );
    } finally {
      outcomePollsInFlightRef.current.delete(requestId);
    }
  }

  useEffect(() => {
    const pending = localJobs.filter((job) => (
      !job.localTiming
      && !job.errorMessage
      && !job.sending
      && (job.phase === 'accepted' || job.acceptedAtMs != null)
    ));
    if (pending.length === 0) return undefined;

    let cancelled = false;
    const poll = () => {
      for (const job of pending) {
        void readAndApplyDurableTranscriptionOutcome(job.requestId, job.source).catch((pollError) => {
          if (!cancelled) {
            recordDiagnostic('transcription outcome read failed', `requestId=${job.requestId} | ${diagnosticErrorDetail(pollError)}`);
          }
        });
      }
    };
    poll();
    const timer = window.setInterval(poll, TRANSCRIPTION_OUTCOME_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [localJobs]);

  async function queueAssetInputs(inputs: CaptionAssetInput[]) {
    recordDiagnostic('choose assets received', assetInputSummary(inputs));
    if (inputs.length === 0) return;
    setError(null);
    setRenderStatus('idle');
    setLastRenderedPath(null);
    setLocalOutputs([]);
    revokeObjectUrl(videoPreviewUrlRef.current);
    videoPreviewUrlRef.current = null;
    setVideoPreviewUrl(null);
    let selectedFirstQueuedInput = false;
    for (const input of inputs) {
      const requestId = createCaptionTranscriptionRequestId();
      const startedAtMs = Date.now();
      recordDiagnostic('local job queued', `requestId=${requestId} | file=${input.displayName} | type=${input.contentType || 'unknown'} | bytes=${input.byteLength}`);
      if (!selectedFirstQueuedInput) {
        selectedFirstQueuedInput = true;
        setSelectedRequestId(requestId);
      }
      setLocalJobs((current) => [
        ...current,
        {
          requestId,
          fileName: input.displayName,
          byteLength: input.byteLength,
          source: null,
          phase: 'queued',
          startedAtMs,
          acceptedAtMs: null,
          mediaDurationSeconds: undefined,
          localTiming: null,
          sending: true,
          errorMessage: null,
        },
      ]);
      try {
        updateLocalJob(requestId, { phase: 'preparing' });
        recordDiagnostic('file source prepare start', `requestId=${requestId} | file=${input.displayName}`);
        const source = await input.loadSource();
        recordDiagnostic('file source prepare complete', `requestId=${requestId} | bytes=${input.byteLength} | contentType=${input.contentType}`);
        void detectMediaDurationSeconds(source).then((mediaDurationSeconds) => {
          updateLocalJob(requestId, { mediaDurationSeconds });
          recordDiagnostic(
            mediaDurationSeconds == null ? 'media duration unavailable' : 'media duration detected',
            mediaDurationSeconds == null
              ? `requestId=${requestId} | file=${input.displayName}`
              : `requestId=${requestId} | seconds=${mediaDurationSeconds.toFixed(2)}`,
          );
        }).catch((durationError) => {
          updateLocalJob(requestId, { mediaDurationSeconds: null });
          recordDiagnostic('media duration failed', `requestId=${requestId} | ${diagnosticErrorDetail(durationError)}`);
        });
        updateLocalJob(requestId, { phase: 'staging' });
        recordDiagnostic('audio artifact stage start', `requestId=${requestId}`);
        const prepared = await prepareCaptionAudioTranscriptionRequest({ requestId, audio: source });
        recordDiagnostic('audio artifact stage complete', `requestId=${requestId} | hash=${prepared.source.kind === 'blob_ref' ? prepared.source.hash : 'not-staged'} | bytes=${prepared.source.byteLength ?? input.byteLength}`);
        updateLocalJob(requestId, { source: prepared.source, phase: 'submitting' });
        recordDiagnostic('transcription submit start', `requestId=${requestId}`);
        const workflowReply = await submitPreparedCaptionAudioTranscriptionRequest(prepared);
        const workflowOutcome = readCaptionTranscriptionWorkflowOutcome(workflowReply, requestId);
        if (applyCaptionWorkflowOutcome(requestId, workflowOutcome, prepared.source)) continue;
        if (await readAndApplyDurableTranscriptionOutcome(requestId, prepared.source)) continue;
        recordDiagnostic('transcription submit accepted', `requestId=${requestId}`);
        updateLocalJob(requestId, {
          source: prepared.source,
          phase: 'accepted',
          acceptedAtMs: Date.now(),
          sending: false,
        });
      } catch (uploadError) {
        const detail = diagnosticErrorDetail(uploadError);
        recordDiagnostic('asset upload/transcription failed', `requestId=${requestId} | ${detail}`);
        updateLocalJob(requestId, {
          phase: 'error',
          sending: false,
          errorMessage: uploadError instanceof Error ? uploadError.message : String(uploadError),
        });
      }
    }
  }

  async function chooseAssets(files: File[]) {
    await queueAssetInputs(files.map(browserFileAssetInput));
  }

  async function chooseLocalAssets() {
    setError(null);
    recordDiagnostic('local file picker start', 'prompt=Choose audio or video files | multiple=yes | source=local-files');
    try {
      const files = await chooseLocalFiles({
        prompt: 'Choose audio or video files',
        multiple: true,
        includeBytes: false,
        allowedContentPrefixes: ['audio/', 'video/'],
        allowedExtensions: CAPTION_ASSET_EXTENSIONS,
      });
      recordDiagnostic(files.length === 0 ? 'local file picker canceled' : 'local file picker selected', assetInputSummary(files.map(localFileAssetInput)));
      await queueAssetInputs(files.map(localFileAssetInput));
    } catch (pickerError) {
      const detail = diagnosticErrorDetail(pickerError);
      recordDiagnostic('local file picker failed', detail);
      setError(pickerError instanceof Error ? pickerError.message : String(pickerError));
    }
  }

  async function chooseLocalManualTiming() {
    setError(null);
    recordDiagnostic('manual timing picker start', 'prompt=Choose caption timing file | multiple=no | source=local-files');
    try {
      const files = await chooseLocalFiles({
        prompt: 'Choose caption timing file',
        multiple: false,
        allowedContentPrefixes: ['application/json', 'text/json'],
        allowedExtensions: ['json'],
      });
      const file = files[0];
      if (!file) {
        recordDiagnostic('manual timing picker canceled', '0 files');
        return;
      }

      recordDiagnostic('manual timing local file selected', `${file.name} (${file.contentType}, ${file.byteLength} bytes)`);
      if (!file.bytes) throw new Error(`Caption timing file did not include bytes: ${file.name}`);
      const text = new TextDecoder().decode(file.bytes);
      try {
        setManualTiming(captionTimingFromJson(text, file.name));
        recordDiagnostic('manual timing parsed', `file=${file.name} | chars=${text.length}`);
      } catch (parseError) {
        recordDiagnostic('manual timing parse failed', diagnosticErrorDetail(parseError));
        setError(parseError instanceof Error ? `Caption timing file is invalid: ${parseError.message}` : 'Caption timing file is invalid.');
      }
    } catch (pickerError) {
      const detail = diagnosticErrorDetail(pickerError);
      recordDiagnostic('manual timing picker failed', detail);
      setError(pickerError instanceof Error ? pickerError.message : String(pickerError));
    }
  }

  async function chooseRenderFolder() {
    setError(null);
    recordDiagnostic('output folder picker start', 'prompt=Save caption video to folder');
    try {
      const folder = await chooseLocalFolder({ prompt: 'Save caption video to folder' });
      if (!folder) {
        recordDiagnostic('output folder picker canceled', '0 folders');
        return;
      }
      setOutputFolder(folder);
      rememberOutputFolder(folder);
      recordDiagnostic('output folder selected', folder);
    } catch (folderError) {
      const detail = diagnosticErrorDetail(folderError);
      recordDiagnostic('output folder picker failed', detail);
      setError(folderError instanceof Error ? folderError.message : String(folderError));
    }
  }

  async function loadRenderedVideoPreview(path: string) {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    try {
      const file = await readLocalFile(path);
      if (!file.bytes) throw new Error(`Rendered video preview did not include bytes: ${path}`);
      const nextUrl = URL.createObjectURL(new Blob([file.bytes.slice()], { type: file.contentType || 'video/mp4' }));
      revokeObjectUrl(videoPreviewUrlRef.current);
      videoPreviewUrlRef.current = nextUrl;
      setVideoPreviewUrl(nextUrl);
      recordDiagnostic('caption render preview loaded', `path=${path} | bytes=${file.byteLength}`);
    } catch (previewError) {
      recordDiagnostic('caption render preview read failed', `path=${path} | ${diagnosticErrorDetail(previewError)}`);
    }
  }

  async function revealRenderedVideo() {
    const path = verifiedOutputPath;
    if (!path) return;
    setError(null);
    try {
      await revealLocalPath(path);
      recordDiagnostic('caption render reveal requested', path);
    } catch (revealError) {
      const detail = diagnosticErrorDetail(revealError);
      recordDiagnostic('caption render reveal failed', detail);
      setError(revealError instanceof Error ? revealError.message : String(revealError));
    }
  }

  async function renderVideo() {
    if (!effectiveAudio) return;
    if (!effectiveTiming) {
      await requestTiming(effectiveAudio);
      return;
    }
    setRunning(true);
    setRenderStatus('rendering');
    setError(null);
    revokeObjectUrl(videoPreviewUrlRef.current);
    videoPreviewUrlRef.current = null;
    setVideoPreviewUrl(null);

    const requestId = createCaptionRenderRequestId();
    const outputPath = captionVideoOutputPath(outputFolder, selectedQueueItem?.fileName);
    const invocation = buildCaptionRenderInvocation({
      requestId,
      audio: effectiveAudio,
      captionTiming: effectiveTiming.source,
      settings,
      outputPath,
    });
    recordDiagnostic('caption render request built', `requestId=${requestId} | metadata=${invocation.metadataAddress} | preset=${settings.presetId} | output=${outputPath}`);
    try {
      recordDiagnostic('caption render submit start', `requestId=${requestId}`);
      const workflowReply = await runCaptionRender({
        requestId,
        audio: effectiveAudio,
        captionTiming: effectiveTiming.source,
        settings,
        outputPath,
      });
      const outcome = readCaptionRenderWorkflowOutcome(workflowReply, invocation.metadataAddress);
      if (outcome?.errorMessage) {
        recordDiagnostic('caption render process failed', `requestId=${requestId} | ${outcome.errorMessage}`);
        setError(outcome.errorMessage);
        setRenderStatus('error');
        return;
      }
      if (!outcome?.record) {
        const missingRecord = 'Caption render finished without a process result. No saved video can be verified.';
        recordDiagnostic('caption render missing result', `requestId=${requestId}`);
        setError(missingRecord);
        setRenderStatus('error');
        return;
      }

      const outputRecord = {
        ...(outcome.record as Record<string, unknown>),
        requested_output_path: outputPath,
      } as CaptionOutputRecord;
      setLocalOutputs((current) => mergeCaptionOutputRecords([outputRecord], current));
      const renderedPath = localOutputPathFromRecord(outputRecord) ?? outputPath;
      setLastRenderedPath(renderedPath);
      await loadRenderedVideoPreview(renderedPath);
      recordDiagnostic('caption render complete', `requestId=${requestId} | output=${renderedPath}`);
      setRenderStatus('ready');
    } catch (renderError) {
      recordDiagnostic('caption render failed', diagnosticErrorDetail(renderError));
      setError(renderError instanceof Error ? renderError.message : String(renderError));
      setRenderStatus('error');
    } finally {
      setRunning(false);
    }
  }

  function downloadCaptions() {
    if (!effectiveTiming) return;
    if (effectiveTiming.source.kind !== 'inline') {
      setError('Captions are stored already. Use the saved caption record.');
      return;
    }
    const blob = new Blob([new Uint8Array(effectiveTiming.source.bytes)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(selectedQueueItem?.fileName ?? 'captions').replace(/\.[^.]+$/, '')}.captions.json`;
    link.click();
    window.setTimeout(() => revokeObjectUrl(url), 0);
  }

  return (
    <Container height="full" minHeight="0" overflow="auto" padding="lg">
      <Container layout="vertical" gap="lg" className="mx-auto w-full max-w-6xl">
        <Card variant="surface" padding="lg" layout="stack">
          <Container layout="horizontal" gap="md" alignItems="start" justifyContent="between" wrap>
            <Container layout="vertical" gap="xs">
              <Text variant="heading-xl">Create a captioned video</Text>
              <Text variant="body-xs" color="faint">Choose a file, preview captions, make the MP4, then open the saved video.</Text>
            </Container>
            <Button variant="ghost" size="sm" onClick={() => setShowAdvanced((current) => !current)}>
              <SlidersHorizontal className="h-4 w-4" />
              Advanced
            </Button>
          </Container>

          <CaptionDropStep
            items={dropItems}
            error={visibleError}
            onFiles={chooseAssets}
            onChooseLocalFiles={chooseLocalAssets}
            onSelectItem={setSelectedRequestId}
            onDiagnostic={recordDiagnostic}
          />

          <Container layout="grid" gridCols={2} gap="lg" className="lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
            <CaptionPreview
              timing={effectiveTiming?.preview ?? null}
              videoUrl={videoPreviewUrl}
              rendering={running}
              outputPath={verifiedOutputPath}
            />

            <Card variant="nested" padding="lg" layout="stack">
              <Container layout="vertical" gap="xs">
                <Text variant="heading">Make video</Text>
                <Text variant="body-xs" color="faint">
                  {canRender ? 'Captions are ready. Render the MP4 here.' : transcribing ? 'Captions are being made.' : 'Add audio or video first.'}
                </Text>
              </Container>

              <Container layout="vertical" gap="sm">
                <Text variant="caption" color="faint">Look</Text>
                <Container layout="horizontal" gap="sm" wrap>
                  {presets.map((preset) => (
                    <Button
                      key={preset.preset_id}
                      variant={preset.preset_id === settings.presetId ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => setSettings((prev) => ({ ...prev, presetId: preset.preset_id ?? prev.presetId }))}
                    >
                      {captionPresetName(preset)}
                    </Button>
                  ))}
                </Container>
                {selectedPreset && (
                  <Text variant="caption" color="faint">
                    {captionPresetName(selectedPreset)} · {(selectedPreset.dimensions?.width ?? 0)}x{(selectedPreset.dimensions?.height ?? 0)}
                  </Text>
                )}
              </Container>

              <Card variant="ghost" padding="none" layout="stack">
                <Container layout="horizontal" alignItems="center" justifyContent="between" gap="md" wrap>
                  <Container layout="vertical" gap="xs" minHeight="0">
                    <Text variant="caption" color="faint">Save folder</Text>
                    <Text variant="body-xs" weight="semibold" truncate>{folderLabel(outputFolder)}</Text>
                  </Container>
                  <Button variant="secondary" size="sm" onClick={() => void chooseRenderFolder()}>
                    <FolderOpen className="h-4 w-4" />
                    Change
                  </Button>
                </Container>
                <Text variant="caption" color="faint" truncate>{plannedOutputPath}</Text>
              </Card>

              <Container layout="horizontal" gap="sm" wrap>
                <Button variant="secondary" size="md" disabled={!effectiveTiming} onClick={downloadCaptions}>
                  <Download className="h-4 w-4" />
                  Save captions
                </Button>
                <Button variant="primary" size="md" loading={running} disabled={!canRender || running} onClick={() => void renderVideo()}>
                  <Play className="h-4 w-4" />
                  Make video
                </Button>
              </Container>

              {renderStatus === 'rendering' && (
                <Text variant="body-xs" color="faint">Rendering MP4. The file appears here when it exists.</Text>
              )}

              {verifiedOutputPath && renderStatus !== 'rendering' && (
                <Card variant="solid" padding="md" layout="stack">
                  <Container layout="vertical" gap="xs" minHeight="0">
                    <Text variant="body-xs" weight="semibold">Video ready</Text>
                    <Text variant="caption" color="faint" truncate>
                      {[bytesLabel(verifiedOutputBytes), verifiedOutputPath].filter(Boolean).join(' · ')}
                    </Text>
                  </Container>
                  <Button variant="success" size="sm" onClick={() => void revealRenderedVideo()}>
                    <ExternalLink className="h-4 w-4" />
                    Reveal in Finder
                  </Button>
                </Card>
              )}

              {visibleError && (
                <Card variant="error" padding="md">
                  <Text variant="body-xs" color="error">{visibleError}</Text>
                </Card>
              )}
            </Card>
          </Container>

          {showAdvanced && (
            <Container layout="grid" gridCols={2} gap="lg">
              <Card variant="nested" padding="lg" layout="stack">
                <Container layout="horizontal" gap="md" alignItems="center">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--glass-bg-subtle)] text-[var(--text-secondary)]">
                    <Settings2 className="h-5 w-5" />
                  </span>
                  <Container layout="vertical" gap="xs">
                    <Text variant="heading">Video settings</Text>
                    <Text variant="body-xs" color="faint">Use defaults unless the output needs adjustment.</Text>
                  </Container>
                </Container>
                <Container layout="grid" gridCols={2} gap="sm">
                  <Input label="FPS" type="number" value={settings.fps} onChange={(event) => setSettings((prev) => ({ ...prev, fps: Number(event.currentTarget.value) || DEFAULT_SETTINGS.fps }))} />
                  <Input label="Quality" type="number" value={settings.quality} onChange={(event) => setSettings((prev) => ({ ...prev, quality: Number(event.currentTarget.value) || DEFAULT_SETTINGS.quality }))} />
                  <Input label="Concurrency" type="number" value={settings.concurrency} onChange={(event) => setSettings((prev) => ({ ...prev, concurrency: Number(event.currentTarget.value) || 1 }))} />
                  <Input label="Audio offset" type="number" step="0.05" value={settings.audioOffsetSeconds} onChange={(event) => setSettings((prev) => ({ ...prev, audioOffsetSeconds: Number(event.currentTarget.value) || 0 }))} />
                </Container>
              </Card>

              <Card variant="nested" padding="lg" layout="stack">
                <Text variant="heading">Existing captions</Text>
                <Text variant="body-xs" color="faint">Pick a timing file only when you already made one.</Text>
                <Button type="button" variant="secondary" size="md" onClick={() => void chooseLocalManualTiming()}>
                  Pick timing file
                </Button>
              </Card>
            </Container>
          )}
        </Card>
      </Container>
    </Container>
  );
}

export { CaptionRendererPanel as mount };
