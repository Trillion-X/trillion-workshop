import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';

import { evidenceBlockerText } from '@/packages/content-media-evidence/read-data/content-media-evidence';
import {
  chooseContentMediaFiles,
  CONTENT_MEDIA_AUDIO_EXTENSIONS,
  CONTENT_MEDIA_IMAGE_EXTENSIONS,
  CONTENT_MEDIA_VIDEO_EXTENSIONS,
  stageContentMediaFile,
} from '@/packages/content-media-evidence/do-work/content-media-work-loop';
import { submitMediaIdentityRequest } from '@/packages/media-identity/do-work/submit-media-identity';
import {
  readMediaIdentityEvidence,
  type MediaIdentityCluster,
  type MediaIdentityMatch,
  type MediaIdentityProfile,
  type MediaIdentityProfileBinding,
  type MediaIdentityRequest,
  type MediaIdentitySignature,
} from '@/packages/media-identity/read-data/read-media-identity';
import {
  OneStepAtATimeSurface,
  type OneStepAtATimeItem,
} from '@/packages/ui/show/one-step-at-a-time-surface';
import { FileWorkAction } from '@/packages/ui/show/file-work-action';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';

export type MediaIdentityPanelProps = {
  profiles?: MediaIdentityProfile[];
  requests?: MediaIdentityRequest[];
  signatures?: MediaIdentitySignature[];
  clusters?: MediaIdentityCluster[];
  profileBindings?: MediaIdentityProfileBinding[];
  matches?: MediaIdentityMatch[];
};

function formatDate(value?: string): string {
  if (!value) return 'time not saved';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function percent(value?: number): number {
  if (typeof value !== 'number') return 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

function bindingKey(binding: MediaIdentityProfileBinding): string {
  return String((binding.cluster_ref as { cluster_id?: unknown } | undefined)?.cluster_id ?? '');
}

function clusterItems(
  clusters: readonly MediaIdentityCluster[],
  profileBindings: readonly MediaIdentityProfileBinding[],
): OneStepAtATimeItem[] {
  const bindingByCluster = new Map(profileBindings.map((binding) => [bindingKey(binding), binding]));
  return clusters.slice(0, 4).map((cluster, index) => {
    const binding = bindingByCluster.get(String(cluster.cluster_id ?? ''));
    return {
      key: String(cluster.cluster_id ?? index),
      title: binding?.profile_label ?? 'Unknown person or voice',
      detail: `${(cluster.member_signature_refs ?? []).length} samples · ${formatDate(cluster.updated_at)}`,
      badge: binding ? 'Named' : 'Unknown',
      tone: binding ? 'success' : 'warning',
    };
  });
}

function Details({
  profiles,
  requests,
  signatures,
  matches,
  blockers,
}: {
  profiles: readonly MediaIdentityProfile[];
  requests: readonly MediaIdentityRequest[];
  signatures: readonly MediaIdentitySignature[];
  matches: readonly MediaIdentityMatch[];
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
        Saved profiles: {profiles.length}. Identity jobs: {requests.length}. Samples: {signatures.length}. Matches: {matches.length}.
      </Text>
      {matches.slice(0, 4).map((match, index) => (
        <Text key={`${match.match_id ?? 'match'}-${index}`} variant="body-xs" color="faint">
          Match {index + 1}: {percent(match.confidence)}%
        </Text>
      ))}
    </Container>
  );
}

export function MediaIdentityPanel({
  profiles: profileProps,
  requests: requestProps,
  signatures: signatureProps,
  clusters: clusterProps,
  profileBindings: bindingProps,
  matches: matchProps,
}: MediaIdentityPanelProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [submittedSourceName, setSubmittedSourceName] = React.useState<string | null>(null);
  const evidenceRows = useBitfieldData('media-identity:contentMediaEvidence');
  const liveEvidence = React.useMemo(() => readMediaIdentityEvidence(evidenceRows), [evidenceRows]);

  const profiles = profileProps ?? liveEvidence.profiles;
  const requests = requestProps ?? liveEvidence.requests;
  const signatures = signatureProps ?? liveEvidence.signatures;
  const clusters = clusterProps ?? liveEvidence.clusters;
  const profileBindings = bindingProps ?? liveEvidence.profileBindings;
  const matches = matchProps ?? liveEvidence.matches;
  const blockers = liveEvidence.blockers.map(evidenceBlockerText);
  const bestMatch = matches[0];
  const namedCount = profileBindings.length;
  const hasProblem = blockers.length > 0;
  const status = hasProblem ? 'Needs attention' : bestMatch || clusters.length ? 'Found' : requests.length ? 'Working' : 'Empty';
  const submitSelectedFile = React.useCallback(async (file: File) => {
    setIsSubmitting(true);
    setLocalError(null);
    setSubmittedSourceName(null);
    try {
      const source = await stageContentMediaFile({
        packageName: 'media-identity',
        file,
      });
      await submitMediaIdentityRequest({ source });
      setSubmittedSourceName(source.display_name);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error); console.error('[media-identity] failed:', raw); setLocalError('Identity work could not be started.');
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
      emptyTitle="Drop face or voice media"
      emptyDetail="Pick photos, videos, or audio files."
      pickLabel="Pick media"
      startLabel="Find people and voices"
      rejectMessage="Choose a photo, video, or audio file."
      successMessage={submittedSourceName ? `Sent ${submittedSourceName}.` : undefined}
      errorMessage={localError ?? undefined}
      onStart={submitSelectedFile}
    />
  );

  return (
    <OneStepAtATimeSurface
      eyebrow="People and voices"
      title="Find people and voices"
      status={status}
      statusTone={hasProblem ? 'warning' : bestMatch || clusters.length ? 'success' : requests.length ? 'info' : 'muted'}
      primaryValue={bestMatch ? `${percent(bestMatch.confidence)}%` : clusters.length ? String(clusters.length) : requests.length ? 'Working' : 'Choose media'}
      primaryLabel={bestMatch ? 'Best identity match.' : clusters.length ? `${namedCount} named, ${Math.max(0, clusters.length - namedCount)} still unknown.` : isSubmitting ? 'Starting identity work.' : requests.length ? 'Looking for recurring people and voices.' : 'Drop media with faces or voices.'}
      primaryDetail={bestMatch ? 'A match is ready.' : undefined}
      action={action}
      nextStep={clusters.length ? 'Name the unknown groups only when you care who they are.' : requests.length ? 'Wait for groups or matches to appear.' : 'Start with any media that contains a face or voice.'}
      itemsTitle="People and voices"
      items={clusterItems(clusters, profileBindings)}
      emptyTitle="No groups yet"
      emptyDetail="When a face or voice repeats, it appears here even before it has a name."
      detailsTitle="More"
      details={<Details profiles={profiles} requests={requests} signatures={signatures} matches={matches} blockers={blockers} />}
    />
  );
}
