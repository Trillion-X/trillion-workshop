import * as React from 'react';
import { Activity } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';

import { evidenceBlockerText } from '@/packages/content-media-evidence/read-data/content-media-evidence';
import { stageContentMediaFile } from '@/packages/content-media-evidence/do-work/content-media-work-loop';
import { submitMotionAnalysisRequest } from '@/packages/motion-analysis/do-work/submit-motion-analysis';
import {
  readMotionAnalysisEvidence,
  type MotionAlignment,
  type MotionAnalysisRequest,
  type MotionComparison,
  type MotionPhase,
  type MotionTrack,
} from '@/packages/motion-analysis/read-data/read-motion-analysis';
import { FileWorkAction } from '@/packages/ui/show/file-work-action';
import { Badge } from '@/packages/ui/show/badge';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';
import { WorkStartState } from '@/packages/ui/show/work-start-state';

export type MotionAnalysisPanelProps = {
  requests?: MotionAnalysisRequest[];
  tracks?: MotionTrack[];
  phases?: MotionPhase[];
  alignments?: MotionAlignment[];
  comparisons?: MotionComparison[];
};

type AnalysisTone = 'neutral' | 'info' | 'success';

type AnalysisItem = {
  key: string;
  title: string;
  detail: string;
  badge: string;
  tone: AnalysisTone;
};

function formatDate(value?: string): string {
  if (!value) return 'time not saved';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatRange(range?: { start?: number; end?: number }): string {
  if (!range || typeof range.start !== 'number') return 'time not saved';
  const end = typeof range.end === 'number' ? range.end : range.start;
  return `${range.start}s to ${end}s`;
}

function percent(value?: number): number {
  if (typeof value !== 'number') return 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

function movementItems(
  phases: readonly MotionPhase[],
  alignments: readonly MotionAlignment[],
  requests: readonly MotionAnalysisRequest[],
): AnalysisItem[] {
  if (phases.length > 0) {
    return phases.slice(0, 4).map((phase, index) => ({
      key: phase.phase_id ?? String(index),
      title: phase.label ?? `Movement part ${index + 1}`,
      detail: formatRange(phase.time_range),
      badge: 'Part',
      tone: 'neutral',
    }));
  }
  if (alignments.length > 0) {
    return alignments.slice(0, 4).map((alignment, index) => ({
      key: alignment.alignment_id ?? String(index),
      title: `Match ${index + 1}`,
      detail: alignment.method ?? 'match method not saved',
      badge: `${percent(alignment.score)}%`,
      tone: percent(alignment.score) >= 80 ? 'success' : 'info',
    }));
  }
  return requests.slice(0, 4).map((request, index) => ({
    key: request.request_id ?? String(index),
    title: `Movement job ${index + 1}`,
    detail: `${request.sources?.length ?? 0} sources · ${formatDate(request.requested_at)}`,
    badge: 'Working',
    tone: 'info',
  }));
}

export function MotionAnalysisPanel({
  requests: requestProps,
  tracks: trackProps,
  phases: phaseProps,
  alignments: alignmentProps,
  comparisons: comparisonProps,
}: MotionAnalysisPanelProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [submittedSourceName, setSubmittedSourceName] = React.useState<string | null>(null);
  const evidenceRows = useBitfieldData('contentMediaEvidence');
  const liveEvidence = React.useMemo(() => readMotionAnalysisEvidence(evidenceRows), [evidenceRows]);

  const requests = requestProps ?? liveEvidence.requests;
  const tracks = trackProps ?? liveEvidence.tracks;
  const phases = phaseProps ?? liveEvidence.phases;
  const alignments = alignmentProps ?? liveEvidence.alignments;
  const comparisons = comparisonProps ?? liveEvidence.comparisons;
  const blockers = liveEvidence.blockers.map(evidenceBlockerText);
  const bestAlignment = alignments[0];
  const hasProblem = blockers.length > 0;
  const hasResult = Boolean(bestAlignment || phases.length || requests.length);
  const status = hasProblem ? 'Needs attention' : bestAlignment || phases.length ? 'Found' : requests.length ? 'Working' : 'Empty';
  const statusTone: 'success' | 'warning' | 'info' | 'neutral' = hasProblem
    ? 'warning'
    : bestAlignment || phases.length
      ? 'success'
      : requests.length
        ? 'info'
        : 'neutral';
  const primaryValue = bestAlignment ? `${percent(bestAlignment.score)}%` : phases.length ? `${phases.length}` : requests.length ? 'Working' : 'No clip yet';
  const primaryLabel = bestAlignment
    ? 'Best movement match'
    : phases.length
      ? 'Movement parts found'
      : isSubmitting
        ? 'Starting movement check'
        : requests.length
          ? 'Movement is being checked'
          : 'Drop a clip to start';
  const primaryDetail = bestAlignment?.method ?? phases[0]?.label ?? undefined;
  const items = movementItems(phases, alignments, requests);
  const itemsTitle = phases.length ? 'Movement parts' : alignments.length ? 'Matches' : 'Movement jobs';

  const submitSelectedFile = React.useCallback(async (file: File) => {
    setIsSubmitting(true);
    setLocalError(null);
    setSubmittedSourceName(null);
    try {
      const source = await stageContentMediaFile({
        packageName: 'motion-analysis',
        file,
      });
      await submitMotionAnalysisRequest({ sources: [source] });
      setSubmittedSourceName(source.display_name);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error); console.error("[motion-analysis] submit failed:", raw); setLocalError("Movement could not be submitted.");
    } finally {
      setIsSubmitting(false);
    }
  }, []);

  return (
    <Container layout="vertical" gap="md">
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
        <Text variant="heading">Swing Analysis</Text>
        <Badge variant={statusTone === 'neutral' ? 'neutral' : statusTone} size="sm">{status}</Badge>
      </Container>

      <FileWorkAction
        accept="video/*"
        acceptsFile={(file) => file.type.startsWith('video/')}
        multiple
        busy={isSubmitting}
        emptyTitle="Drop a swing clip"
        emptyDetail="MP4 or MOV — drag it here or click to choose"
        pickLabel="Choose video"
        startLabel="Check movement"
        rejectMessage="Choose a video file."
        successMessage={submittedSourceName ? `Sent ${submittedSourceName}.` : undefined}
        errorMessage={localError ?? undefined}
        onStart={submitSelectedFile}
      />

      {hasResult ? (
        <Card variant="nested" padding="md">
          <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between" wrap>
            <Container layout="vertical" gap="xs">
              <Text variant="caption" color="faint">{primaryLabel}</Text>
              <Text variant="heading-lg" leading="tight" mono tabular>{primaryValue}</Text>
              {primaryDetail ? <Text variant="body-xs" color="faint">{primaryDetail}</Text> : null}
            </Container>
            <Badge variant={statusTone === 'neutral' ? 'neutral' : statusTone} size="lg">{status}</Badge>
          </Container>
        </Card>
      ) : (
        <WorkStartState
          icon={Activity}
          title="Drop a swing to check movement"
          description="Pick a clip and the analysis finds the movement parts, body tracks, and the closest matching swing."
        />
      )}

      {hasResult && items.length > 0 ? (
        <Container layout="vertical" gap="xs">
          <Text variant="heading">{itemsTitle}</Text>
          {items.map((item) => (
            <Card key={item.key} variant="nested" padding="md">
              <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
                <Container layout="vertical" gap="xs">
                  <Text variant="body" leading="tight">{item.title}</Text>
                  <Text variant="body-xs" color="faint">{item.detail}</Text>
                </Container>
                <Badge variant={item.tone} size="sm">{item.badge}</Badge>
              </Container>
            </Card>
          ))}
        </Container>
      ) : null}

      <Container layout="vertical" gap="sm">
        {blockers.map((blocker, index) => (
          <Text key={`blocker-${index}`} variant="body-xs" color="warning">
            {blocker}
          </Text>
        ))}
        <Text variant="body-xs" color="faint">
          Movement jobs: {requests.length}. Body tracks: {tracks.length}. Matches: {alignments.length}. Comparisons: {comparisons.length}.
        </Text>
      </Container>
    </Container>
  );
}
