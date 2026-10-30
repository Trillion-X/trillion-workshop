// package-set://bitfield-studio/packages/audio-transcription/show/AudioTranscriptionPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Turn audio into text. The surface lists every recording the log currently
// holds that describes itself as transcribable (`source_ref.role` of
// stored-audio / stored-video on any package's published records — discovered
// by ROLE, never by producer name), turns one into text with a single press,
// and shows finished transcripts. Picking a file stays available as the quiet
// alternative for media that is not in the log yet.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Source discovery is role-keyed over the generic published-records input.
//    This package never names, imports, or special-cases a producer package.
// 2. Every job goes through the owner workflow action
//    (action:submit-audio-transcription-request) — envelopes and addresses
//    only.
// 3. All styling through @/packages/ui + screen-look tokens; flat sections
//    with dividers, no nested card stacks, no raw colors, no gradients.
// 4. Jobs, transcripts, and errors render only from this package's evidence
//    lane in current log state.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';

import {
  evidencePayloads,
  readEvidenceProjection,
} from '@/packages/content-media-evidence/read-data/content-media-evidence';
import {
  chooseContentMediaFiles,
  CONTENT_MEDIA_AUDIO_EXTENSIONS,
  CONTENT_MEDIA_VIDEO_EXTENSIONS,
  stageContentMediaFile,
} from '@/packages/content-media-evidence/do-work/content-media-work-loop';
import { submitAudioTranscriptionRequest } from '@/packages/audio-transcription/do-work/submit-audio-transcription';
import { readPlaceableSurfaceSubject } from '@/packages/ui/show/placeable-surface-intent/placeable-surface-subject';
import {
  Button,
  Container,
  HoverRevealGroup,
  HoverRevealItem,
  OneStepAtATimeSurface,
  Text,
} from '@/packages/ui';

type SourceArtifactRef = {
  multihash?: string;
  cas_address?: string;
  media_type?: string;
  byte_length?: number;
};

type TranscribableSource = {
  role: string;
  media_type?: string;
  display_name?: string;
  artifact_ref: SourceArtifactRef;
};

type TranscriptionRequest = {
  kind?: string;
  request_id?: string;
  source?: { media_type?: string; display_name?: string; artifact_ref?: SourceArtifactRef };
  requested_at?: string;
};

type TranscriptionResult = {
  kind?: string;
  request_id?: string;
  source_artifact_ref?: SourceArtifactRef;
  source_fingerprint?: string;
  command_run_id?: string;
  language?: string;
  full_text?: string;
  words?: unknown[];
  segments?: unknown[];
  completed_at?: string;
};

type TranscriptionError = {
  kind?: string;
  request_id?: string;
  code?: string;
  message?: string;
  observed_at?: string;
};

export type AudioTranscriptionPanelProps = {
  requests?: TranscriptionRequest[];
  results?: TranscriptionResult[];
  errors?: TranscriptionError[];
  sources?: TranscribableSource[];
  /**
   * Generic placement input from the host. When another surface places this
   * one with a subject (a recording offered as material), `subjectRef` points
   * at the browser-local subject snapshot and that source is brought to the
   * front with the accent action.
   */
  surfaceInput?: Record<string, unknown>;
};

function subjectSourceFingerprint(surfaceInput: Record<string, unknown> | undefined): string | null {
  const ref = surfaceInput?.subjectRef;
  if (!isRecord(ref) || typeof ref.address !== 'string' || !ref.address) return null;
  const snapshot = readPlaceableSurfaceSubject({ address: ref.address });
  const content = snapshot?.content;
  if (!isRecord(content)) return null;
  const sourceRef = content.source_ref;
  if (!isRecord(sourceRef)) return null;
  const artifactRef = sourceRef.artifact_ref;
  if (!isRecord(artifactRef)) return null;
  const fingerprint = artifactRef.multihash ?? artifactRef.cas_address;
  return typeof fingerprint === 'string' && fingerprint.length > 0 ? fingerprint : null;
}

// The roles this package declares it can consume — mirrored from its own
// evidence-pipeline config record (artifact_roles.source). Society data owned
// by THIS package; never a producer list.
const TRANSCRIBABLE_SOURCE_ROLES = new Set(['stored-audio', 'stored-video']);

function formatDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readTranscribableSource(payload: unknown): TranscribableSource | null {
  if (!isRecord(payload)) return null;
  const sourceRef = payload.source_ref;
  if (!isRecord(sourceRef)) return null;
  const role = typeof sourceRef.role === 'string' ? sourceRef.role : '';
  if (!TRANSCRIBABLE_SOURCE_ROLES.has(role)) return null;
  const artifactRef = sourceRef.artifact_ref;
  if (!isRecord(artifactRef)) return null;
  const fingerprint = artifactRef.multihash ?? artifactRef.cas_address;
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) return null;
  return {
    role,
    media_type: typeof sourceRef.media_type === 'string' ? sourceRef.media_type : undefined,
    display_name: typeof sourceRef.display_name === 'string' ? sourceRef.display_name : undefined,
    artifact_ref: artifactRef as SourceArtifactRef,
  };
}

function sourceRecordedAt(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const value = payload.recorded_at ?? payload.created_at ?? payload.observed_at;
  return typeof value === 'string' ? value : '';
}

function humanClipName(recordedAt: string, source: TranscribableSource): string {
  const kind = source.role === 'stored-video' ? 'Video' : 'Recording';
  const at = new Date(recordedAt);
  if (Number.isNaN(at.getTime())) return kind;
  const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at);
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
  return `${kind} ${day} ${time}`;
}

function sourceLabel(payload: unknown, source: TranscribableSource, recordedAt: string): string {
  if (isRecord(payload) && typeof payload.label === 'string' && payload.label.trim()) {
    return payload.label;
  }
  // Never surface machine identifiers (ISO timestamps in display_name).
  return humanClipName(recordedAt, source);
}

type ListedSource = {
  fingerprint: string;
  label: string;
  whenLabel: string;
  kindLabel: string;
  recordedAt: string;
  source: TranscribableSource;
};

function readListedSources(rows: unknown): ListedSource[] {
  if (!Array.isArray(rows)) return [];
  const byFingerprint = new Map<string, ListedSource>();
  for (const candidate of rows) {
    if (!isRecord(candidate)) continue;
    const source = readTranscribableSource(candidate.payload);
    if (!source) continue;
    const fingerprint = String(source.artifact_ref.multihash ?? source.artifact_ref.cas_address);
    const recordedAt = sourceRecordedAt(candidate.payload);
    const listed: ListedSource = {
      fingerprint,
      label: sourceLabel(candidate.payload, source, recordedAt),
      whenLabel: formatDate(recordedAt),
      kindLabel: source.role === 'stored-video' ? 'video' : 'audio',
      recordedAt,
      source,
    };
    const existing = byFingerprint.get(fingerprint);
    // Keep the row with the richest label (a person-chosen name wins over a
    // generated display name for the same bytes).
    if (!existing) byFingerprint.set(fingerprint, listed);
  }
  return [...byFingerprint.values()].sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
}

function resultFingerprint(result: TranscriptionResult): string {
  return String(result.source_fingerprint ?? result.source_artifact_ref?.multihash ?? '');
}

export function AudioTranscriptionPanel({
  requests: requestProps,
  results: resultProps,
  errors: errorProps,
  sources: sourceProps,
  surfaceInput,
}: AudioTranscriptionPanelProps) {
  const [busyFingerprint, setBusyFingerprint] = React.useState<string | null>(null);
  const [isPicking, setIsPicking] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const evidenceRows = useBitfieldData('audio-transcription:contentMediaEvidence');
  const publishedRows = useBitfieldData('published-records');
  const evidence = React.useMemo(
    () => readEvidenceProjection(evidenceRows, 'audio-transcription'),
    [evidenceRows],
  );
  const liveRequests = evidencePayloads<TranscriptionRequest>(evidence, 'requests');
  const liveResults = evidencePayloads<TranscriptionResult>(evidence, 'results');
  const liveErrors = evidencePayloads<TranscriptionError>(evidence, 'errors');
  const liveSources = React.useMemo(() => readListedSources(publishedRows), [publishedRows]);

  const requests = requestProps ?? liveRequests;
  const results = resultProps ?? liveResults;
  const errors = errorProps ?? liveErrors;
  const unorderedSources = sourceProps
    ? sourceProps.map((source) => ({
      fingerprint: String(source.artifact_ref.multihash ?? ''),
      label: source.display_name ?? 'Recording',
      whenLabel: '',
      kindLabel: source.role === 'stored-video' ? 'video' : 'audio',
      recordedAt: '',
      source,
    }))
    : liveSources;

  // A subject placed with this surface jumps to the front and carries the
  // accent action — the person arrived here FOR that recording.
  const subjectFingerprint = React.useMemo(
    () => subjectSourceFingerprint(surfaceInput),
    [surfaceInput],
  );
  const listedSources = React.useMemo(() => {
    if (!subjectFingerprint) return unorderedSources;
    const subject = unorderedSources.filter((listed) => listed.fingerprint === subjectFingerprint);
    if (subject.length === 0) return unorderedSources;
    return [...subject, ...unorderedSources.filter((listed) => listed.fingerprint !== subjectFingerprint)];
  }, [subjectFingerprint, unorderedSources]);

  const resultsByFingerprint = React.useMemo(() => {
    const map = new Map<string, TranscriptionResult>();
    for (const result of results) {
      const fingerprint = resultFingerprint(result);
      if (fingerprint && !map.has(fingerprint)) map.set(fingerprint, result);
    }
    return map;
  }, [results]);

  const pendingCount = Math.max(0, requests.length - results.length);
  const latestResult = results[0];
  // Structural feed blockers (platform lane: the maintained evidence
  // projection does not materialize live) are intentionally not rendered —
  // internal state never faces the user. Real job errors render below.
  const hasProblem = errors.length > 0;

  const submitSource = React.useCallback(async (listed: ListedSource) => {
    setBusyFingerprint(listed.fingerprint);
    setLocalError(null);
    try {
      await submitAudioTranscriptionRequest({ source: listed.source });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[audio-transcription] submit recording failed:', raw);
      setLocalError('The recording could not be submitted.');
    } finally {
      setBusyFingerprint(null);
    }
  }, []);

  const pickFiles = React.useCallback(async () => {
    setIsPicking(true);
    setLocalError(null);
    try {
      const files = await chooseContentMediaFiles({
        prompt: 'Choose audio or video files',
        multiple: true,
        allowedContentPrefixes: ['audio/', 'video/'],
        allowedExtensions: [...CONTENT_MEDIA_AUDIO_EXTENSIONS, ...CONTENT_MEDIA_VIDEO_EXTENSIONS],
      });
      for (const file of files) {
        const source = await stageContentMediaFile({ packageName: 'audio-transcription', file });
        await submitAudioTranscriptionRequest({ source });
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[audio-transcription] submit file failed:', raw);
      setLocalError('The file could not be submitted.');
    } finally {
      setIsPicking(false);
    }
  }, []);

  const status = hasProblem
    ? 'Needs attention'
    : pendingCount > 0
      ? 'Working'
      : latestResult
        ? 'Ready'
        : listedSources.length > 0
          ? undefined
          : 'Empty';
  const primaryValue = pendingCount > 0
    ? 'Working'
    : results.length > 0
      ? `${results.length} transcript${results.length === 1 ? '' : 's'}`
      : listedSources.length > 0
        ? `${listedSources.length} recording${listedSources.length === 1 ? '' : 's'}`
        : 'No audio yet.';
  const primaryLabel = pendingCount > 0
    ? 'Audio is being turned into text.'
    : latestResult?.full_text
      ? latestResult.full_text
      : listedSources.length > 0
        ? 'Pick a recording below.'
        : 'Record something or pick a file.';

  return (
    <OneStepAtATimeSurface
      eyebrow="Audio to text"
      title="Turn audio into text"
      density="compact"
      status={status}
      statusTone={hasProblem ? 'warning' : latestResult ? 'success' : pendingCount > 0 ? 'info' : 'muted'}
      primaryValue={primaryValue}
      primaryLabel={primaryLabel}
    >
      <Container layout="vertical" gap="xl">
        <Container layout="vertical" gap="md">
            <Text variant="heading">Recordings</Text>
            {listedSources.length > 0 ? (() => {
              const newestUntranscribed = listedSources.find(
                (candidate) => !resultsByFingerprint.has(candidate.fingerprint),
              )?.fingerprint;
              // One accent action per screen (reference law): the placed
              // subject wins it; otherwise the newest recording without text.
              const accentFingerprint = subjectFingerprint
                && listedSources.some((candidate) => candidate.fingerprint === subjectFingerprint)
                ? subjectFingerprint
                : newestUntranscribed;
              return listedSources.map((listed) => {
                const finished = resultsByFingerprint.get(listed.fingerprint);
                const meta = [listed.kindLabel, listed.whenLabel].filter(Boolean).join(' · ');
                const accent = listed.fingerprint === accentFingerprint;
                return (
                  <HoverRevealGroup key={listed.fingerprint} layout="horizontal" gap="sm" alignItems="center">
                    <Container layout="vertical" gap="none" flex="1">
                      <Text variant="body" weight="semibold">{listed.label}</Text>
                    </Container>
                    {finished ? (
                      <Text variant="body-xs" color="faint">Text ready</Text>
                    ) : null}
                    {meta ? <Text variant="body-xs" color="faint" tabular>{meta}</Text> : null}
                    {accent ? (
                      <Button
                        variant="primary"
                        size="sm"
                        loading={busyFingerprint === listed.fingerprint}
                        disabled={busyFingerprint !== null}
                        onClick={() => void submitSource(listed)}
                      >
                        Turn into text
                      </Button>
                    ) : (
                      <HoverRevealItem>
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={busyFingerprint === listed.fingerprint}
                          disabled={busyFingerprint !== null}
                          onClick={() => void submitSource(listed)}
                        >
                          {finished ? 'Again' : 'Turn into text'}
                        </Button>
                      </HoverRevealItem>
                    )}
                  </HoverRevealGroup>
                );
              });
            })() : (
              <Text variant="body-xs" color="faint">Record something first, or pick a file.</Text>
            )}
            <Container layout="horizontal" gap="sm" alignItems="center">
              <Button variant="ghost" size="sm" loading={isPicking} disabled={isPicking} onClick={() => void pickFiles()}>
                Pick an audio or video file
              </Button>
            </Container>
        </Container>

        {results.length > 0 ? (
          <Container layout="vertical" gap="md">
              <Text variant="heading">Transcripts</Text>
              {results.slice(0, 8).map((result, index) => (
                <Container key={`${result.request_id ?? 'result'}-${index}`} layout="vertical" gap="none">
                  <Text variant="body" wrap="preserve">{result.full_text || 'Text not included.'}</Text>
                  <Text variant="body-xs" color="faint">
                    {[result.language, formatDate(result.completed_at)].filter(Boolean).join(' · ')}
                  </Text>
                </Container>
              ))}
          </Container>
        ) : null}

        {localError ? <Text variant="body-xs" color="error">{localError}</Text> : null}

        {errors.length > 0 ? (
          <Container layout="vertical" gap="sm">
              <Text variant="heading">What happened</Text>
              {errors.slice(0, 4).map((error, index) => (
                <Text key={`${error.request_id ?? error.code ?? 'error'}-${index}`} variant="body-xs" color="faint" wrap="preserve">
                  {error.message ?? 'A job needs attention.'}
                </Text>
              ))}
          </Container>
        ) : null}
      </Container>
    </OneStepAtATimeSurface>
  );
}
