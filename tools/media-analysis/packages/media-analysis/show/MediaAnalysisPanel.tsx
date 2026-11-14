import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';

import {
  evidenceBlockerText,
  evidencePayloads,
  readEvidenceProjection,
} from '@/packages/content-media-evidence/read-data/content-media-evidence';
import {
  chooseContentMediaFiles,
  CONTENT_MEDIA_AUDIO_EXTENSIONS,
  CONTENT_MEDIA_IMAGE_EXTENSIONS,
  CONTENT_MEDIA_VIDEO_EXTENSIONS,
  stageContentMediaFile,
} from '@/packages/content-media-evidence/do-work/content-media-work-loop';
import { submitMediaAnalysisRequest } from '@/packages/media-analysis/do-work/submit-media-analysis';
import {
  OneStepAtATimeSurface,
  type OneStepAtATimeItem,
} from '@/packages/ui/show/one-step-at-a-time-surface';
import { FileWorkAction } from '@/packages/ui/show/file-work-action';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';

type MediaRequest = {
  kind?: string;
  request_id?: string;
  source?: { media_type?: string; display_name?: string; artifact_ref?: { multihash?: string; cas_address?: string } };
  lanes?: Record<string, boolean>;
  requested_at?: string;
};

type MediaClaim = {
  kind?: string;
  claim_id?: string;
  request_id?: string;
  claim_type?: string;
  claim_key?: string;
  confidence?: number;
  value?: unknown;
  evidence?: unknown;
};

type MediaEmbedding = {
  kind?: string;
  embedding_id?: string;
  asset_id?: string;
  modality?: string;
  model?: { name?: string; dimensions?: number };
  time_range?: { start?: number; end?: number };
  created_at?: string;
};

type MediaChapter = {
  kind?: string;
  chapter_id?: string;
  title?: string;
  start_time?: number;
  end_time?: number;
};

type MediaThumbnail = {
  kind?: string;
  thumbnail_id?: string;
  time?: number;
  artifact_ref?: { multihash?: string; cas_address?: string };
};

export type MediaAnalysisPanelProps = {
  requests?: MediaRequest[];
  claims?: MediaClaim[];
  embeddings?: MediaEmbedding[];
  chapters?: MediaChapter[];
  thumbnails?: MediaThumbnail[];
};

function formatDate(value?: string): string {
  if (!value) return 'time not saved';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function confidencePercent(value?: number): number {
  if (typeof value !== 'number') return 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

function sourceText(request: MediaRequest): string {
  return request.source?.display_name
    ?? request.source?.media_type
    ?? 'media source not saved yet';
}

function activeChecks(request: MediaRequest): string {
  const active = Object.entries(request.lanes ?? {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => name.replace(/[-_]/g, ' '));
  return active.length ? active.join(', ') : 'automatic checks';
}

function plainValue(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry != null && entry !== '')
      .slice(0, 2)
      .map(([key, entry]) => `${key.replace(/[-_]/g, ' ')} ${plainValue(entry)}`);
    return entries.join(', ');
  }
  return String(value);
}

function claimDetail(claim: MediaClaim): string {
  return plainValue(claim.value) || plainValue(claim.evidence) || 'Finding saved.';
}

function findingItems(claims: readonly MediaClaim[], requests: readonly MediaRequest[]): OneStepAtATimeItem[] {
  if (claims.length > 0) {
    return claims.slice(0, 4).map((claim, index) => ({
      key: claim.claim_id ?? String(index),
      title: claim.claim_key ?? claim.claim_type ?? `Finding ${index + 1}`,
      detail: claimDetail(claim),
      badge: `${confidencePercent(claim.confidence)}%`,
      tone: confidencePercent(claim.confidence) >= 80 ? 'success' : 'info',
    }));
  }
  return requests.slice(0, 4).map((request, index) => ({
    key: request.request_id ?? String(index),
    title: `Media job ${index + 1}`,
    detail: `${sourceText(request)} · ${activeChecks(request)} · ${formatDate(request.requested_at)}`,
    badge: 'Working',
    tone: 'info',
  }));
}

function Details({
  requests,
  embeddings,
  chapters,
  thumbnails,
  blockers,
}: {
  requests: readonly MediaRequest[];
  embeddings: readonly MediaEmbedding[];
  chapters: readonly MediaChapter[];
  thumbnails: readonly MediaThumbnail[];
  blockers: string[];
}) {
  return (
    <Container layout="vertical" gap="sm">
      {blockers.map((blocker, index) => (
        <Text key={`blocker-${index}`} variant="body-xs" color="warning">
          {blocker}
        </Text>
      ))}
      <Text variant="body-xs" color="faint">
        Media jobs: {requests.length}. Search vectors: {embeddings.length}. Chapters: {chapters.length}. Preview frames: {thumbnails.length}.
      </Text>
      {requests.slice(0, 4).map((request, index) => (
        <Text key={`${request.request_id ?? 'request'}-${index}`} variant="body-xs" color="faint">
          Job {index + 1}: {sourceText(request)} · {activeChecks(request)}
        </Text>
      ))}
    </Container>
  );
}

export function MediaAnalysisPanel({
  requests: requestProps,
  claims: claimProps,
  embeddings: embeddingProps,
  chapters: chapterProps,
  thumbnails: thumbnailProps,
}: MediaAnalysisPanelProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [submittedSourceName, setSubmittedSourceName] = React.useState<string | null>(null);
  const evidenceRows = useBitfieldData('media-analysis:contentMediaEvidence');
  const evidence = React.useMemo(
    () => readEvidenceProjection(evidenceRows, 'media-analysis'),
    [evidenceRows],
  );
  const liveRequests = evidencePayloads<MediaRequest>(evidence, 'requests');
  const liveClaims = evidencePayloads<MediaClaim>(evidence, 'claims');
  const liveEmbeddings = evidencePayloads<MediaEmbedding>(evidence, 'embeddings');
  const liveChapters = evidencePayloads<MediaChapter>(evidence, 'chapters');
  const liveThumbnails = evidencePayloads<MediaThumbnail>(evidence, 'thumbnails');

  const requests = requestProps ?? liveRequests;
  const claims = claimProps ?? liveClaims;
  const embeddings = embeddingProps ?? liveEmbeddings;
  const chapters = chapterProps ?? liveChapters;
  const thumbnails = thumbnailProps ?? liveThumbnails;
  const blockers = evidence.blockers.map(evidenceBlockerText);
  const topClaim = claims[0];
  const hasProblem = blockers.length > 0;
  const status = hasProblem ? 'Needs attention' : topClaim ? 'Found' : requests.length ? 'Working' : 'Empty';
  const submitSelectedFile = React.useCallback(async (file: File) => {
    setIsSubmitting(true);
    setLocalError(null);
    setSubmittedSourceName(null);
    try {
      const source = await stageContentMediaFile({
        packageName: 'media-analysis',
        file,
      });
      await submitMediaAnalysisRequest({ source });
      setSubmittedSourceName(source.display_name);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error); console.error('[media-analysis] failed:', raw); setLocalError('Media could not be submitted.');
    } finally {
      setIsSubmitting(false);
    }
  }, []);
  const action = (
    <FileWorkAction
      accept="audio/*,video/*,image/*"
      acceptsFile={(file) => file.type.startsWith('audio/') || file.type.startsWith('video/') || file.type.startsWith('image/')}
      pickFiles={() => chooseContentMediaFiles({
        prompt: 'Choose media files',
        multiple: true,
        allowedContentPrefixes: ['audio/', 'video/', 'image/'],
        allowedExtensions: [
          ...CONTENT_MEDIA_AUDIO_EXTENSIONS,
          ...CONTENT_MEDIA_VIDEO_EXTENSIONS,
          ...CONTENT_MEDIA_IMAGE_EXTENSIONS,
        ],
      })}
      multiple
      busy={isSubmitting}
      emptyTitle="Drop media"
      emptyDetail="Pick photos, videos, or audio files."
      pickLabel="Pick media"
      startLabel="Analyze media"
      rejectMessage="Choose a photo, video, or audio file."
      successMessage={submittedSourceName ? `Sent ${submittedSourceName}.` : undefined}
      errorMessage={localError ?? undefined}
      onStart={submitSelectedFile}
    />
  );

  return (
    <OneStepAtATimeSurface
      eyebrow="Analyze"
      title="Analyze photos and videos"
      status={status}
      statusTone={hasProblem ? 'warning' : topClaim ? 'success' : requests.length ? 'info' : 'muted'}
      primaryValue={topClaim ? `${confidencePercent(topClaim.confidence)}%` : requests.length ? 'Working' : 'Choose file'}
      primaryLabel={topClaim?.claim_key ?? topClaim?.claim_type ?? (isSubmitting ? 'Starting analysis.' : requests.length ? 'Media is being scanned.' : 'Drop media here.')}
      primaryDetail={topClaim ? claimDetail(topClaim) : undefined}
      action={action}
      nextStep={topClaim ? 'Use the finding in search or editing.' : requests.length ? 'Wait for the strongest finding.' : undefined}
      itemsTitle={claims.length ? 'Findings' : 'Media jobs'}
      items={findingItems(claims, requests)}
      emptyTitle="No media scan yet"
      emptyDetail="When media is scanned, the first useful finding appears here."
      detailsTitle="More"
      details={<Details requests={requests} embeddings={embeddings} chapters={chapters} thumbnails={thumbnails} blockers={blockers} />}
    />
  );
}
