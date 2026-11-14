import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Badge } from '@/packages/ui/show/badge';
import { Button } from '@/packages/ui/show/button';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Textarea } from '@/packages/ui/show/input';
import { MediaThumb } from '@/packages/ui/show/media-thumb';
import { MediaFrame } from '@/packages/ui/show/media-frame';
import { Text } from '@/packages/ui/show/text';
import { FileWorkAction } from '@/packages/ui/show/file-work-action';
import { stageContentMediaFile } from '@/packages/content-media-evidence/do-work/content-media-work-loop';
import {
  attachCoachingNote,
  buildAttachCoachingNoteInput,
} from '@/packages/motion-comparison/do-work/attach-coaching-note';
import {
  buildRequestMotionComparisonInput,
  requestMotionComparison,
} from '@/packages/motion-comparison/do-work/request-motion-comparison';
import {
  motionComparisonViews,
  readMotionComparisonState,
} from '@/packages/motion-comparison/read-data/read-motion-comparison';
import { useRenderVideoUrl } from '@/packages/motion-comparison/read-data/render-video';
import type {
  MotionComparisonIntent,
  MotionComparisonView,
} from '@/packages/motion-comparison/read-data/motion-comparison-factor-types';

type MotionComparisonSurfaceProps = {
  userId?: string;
};

type StagedClip = {
  clipId: string;
  label: string;
  mediaRef: string;
  fileName: string;
  mediaType: string;
};

type ClipRole = 'source' | 'reference';

const intentLabels: Array<{ intent: MotionComparisonIntent; label: string }> = [
  { intent: 'coaching-review', label: 'Coaching review' },
  { intent: 'same-view', label: 'Same view' },
  { intent: 'same-phase', label: 'Same moment' },
  { intent: 'same-motion', label: 'Same move' },
];

function clipId(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `motion-clip:${slug || crypto.randomUUID()}`;
}

function clipLabelFromName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').trim();
  return base || name;
}

/**
 * One side of the comparison. Empty → a real drag-and-drop / click video zone
 * (the Mobbin upload-empty-state anatomy: dashed zone, one bold line, pick
 * button). Filled → a media tile + the chosen file name + Replace. No text
 * "video link" field anywhere; the user drops a clip and the label is the
 * file name.
 */
function ClipSlot({
  eyebrow,
  emptyTitle,
  emptyDetail,
  clip,
  busy,
  error,
  onPick,
  onClear,
}: {
  eyebrow: string;
  emptyTitle: string;
  emptyDetail: string;
  clip: StagedClip | null;
  busy: boolean;
  error: string | null;
  onPick: (file: File) => Promise<void> | void;
  onClear: () => void;
}) {
  if (clip) {
    return (
      <Card variant="nested" padding="md">
        <Container layout="vertical" gap="sm">
          <Text variant="body-xs" color="faint">{eyebrow}</Text>
          <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
            <Container layout="horizontal" gap="sm" alignItems="center">
              <MediaThumb family={clip.mediaType || 'video'} selected />
              <Container layout="vertical" gap="xs">
                <Text variant="body" leading="tight">{clip.fileName}</Text>
                <Text variant="body-xs" color="success">Ready to compare</Text>
              </Container>
            </Container>
            <Button type="button" variant="secondary" size="sm" onClick={onClear} disabled={busy}>
              Replace
            </Button>
          </Container>
        </Container>
      </Card>
    );
  }
  return (
    <Container layout="vertical" gap="xs">
      <Text variant="body-xs" color="faint">{eyebrow}</Text>
      <FileWorkAction
        accept="video/*"
        acceptsFile={(file) => file.type.startsWith('video/')}
        busy={busy}
        startWhenFilesAccepted
        showStartAction={false}
        emptyTitle={emptyTitle}
        emptyDetail={emptyDetail}
        pickLabel="Choose video"
        startLabel="Add"
        rejectMessage="Choose a video file."
        errorMessage={error ?? undefined}
        onStart={onPick}
      />
    </Container>
  );
}

export function MotionComparisonSurface({ userId }: MotionComparisonSurfaceProps) {
  const rows = useBitfieldData('published-records');
  const state = React.useMemo(() => readMotionComparisonState(rows), [rows]);
  const views = React.useMemo(() => motionComparisonViews(state), [state]);
  const [sourceClip, setSourceClip] = React.useState<StagedClip | null>(null);
  const [referenceClip, setReferenceClip] = React.useState<StagedClip | null>(null);
  const [staging, setStaging] = React.useState<ClipRole | null>(null);
  const [slotError, setSlotError] = React.useState<string | null>(null);
  const [intent, setIntent] = React.useState<MotionComparisonIntent>('coaching-review');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const first = views[0];
  const renderVideoUrl = useRenderVideoUrl(first?.render);
  const canRequest = Boolean(sourceClip && referenceClip && !busy && !staging);

  const stageInto = React.useCallback(
    (role: ClipRole) => async (file: File) => {
      setStaging(role);
      setSlotError(null);
      setMessage(null);
      try {
        const source = await stageContentMediaFile({ packageName: 'motion-comparison', file });
        const label = clipLabelFromName(source.display_name);
        const clip: StagedClip = {
          clipId: clipId(label),
          label,
          mediaRef: source.artifact_ref.stored_bytes_address_label ?? source.artifact_ref.cas_address,
          fileName: source.display_name,
          mediaType: source.media_type,
        };
        if (role === 'source') setSourceClip(clip);
        else setReferenceClip(clip);
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        console.error('[motion-comparison] add clip failed:', raw);
        setSlotError('That clip could not be added.');
      } finally {
        setStaging(null);
      }
    },
    [],
  );

  const request = React.useCallback(async () => {
    if (!sourceClip || !referenceClip) return;
    setBusy(true);
    setMessage(null);
    try {
      await requestMotionComparison(buildRequestMotionComparisonInput({
        intent,
        requestedBy: userId,
        sourceClip: { clipId: sourceClip.clipId, label: sourceClip.label, mediaRef: sourceClip.mediaRef },
        referenceClip: { clipId: referenceClip.clipId, label: referenceClip.label, mediaRef: referenceClip.mediaRef },
      }));
      setMessage('Comparison requested.');
    } catch {
      setMessage('Comparison could not be requested.');
    } finally {
      setBusy(false);
    }
  }, [intent, referenceClip, sourceClip, userId]);

  const attachNote = React.useCallback(async (view: MotionComparisonView | undefined) => {
    if (!view?.result) {
      setMessage('Choose a finished comparison first.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await attachCoachingNote(buildAttachCoachingNoteInput({
        comparisonId: view.result.comparisonId,
        createdBy: userId,
        note,
      }));
      setNote('');
      setMessage('Coaching note saved.');
    } catch {
      setMessage('Coaching note could not save.');
    } finally {
      setBusy(false);
    }
  }, [note, userId]);

  return (
    <Container layout="vertical" gap="md">
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
        <Text variant="heading">Side-by-Side</Text>
        <Badge variant={first?.result ? 'success' : first ? 'info' : 'neutral'} size="sm">
          {first?.result ? 'Matched' : first ? 'Requested' : 'Ready'}
        </Badge>
      </Container>
      <Container layout="grid" gridCols={2} gap="sm">
        <ClipSlot
          eyebrow="Your clip"
          emptyTitle="Drop your clip"
          emptyDetail="MP4 or MOV — drag it here or click to choose"
          clip={sourceClip}
          busy={staging === 'source'}
          error={staging === 'source' ? null : slotError}
          onPick={stageInto('source')}
          onClear={() => setSourceClip(null)}
        />
        <ClipSlot
          eyebrow="Reference clip"
          emptyTitle="Drop the reference clip"
          emptyDetail="MP4 or MOV — the swing to compare against"
          clip={referenceClip}
          busy={staging === 'reference'}
          error={staging === 'reference' ? null : slotError}
          onPick={stageInto('reference')}
          onClear={() => setReferenceClip(null)}
        />
      </Container>
      <Container layout="horizontal" gap="sm" wrap>
        {intentLabels.map((item) => (
          <Button key={item.intent} type="button" variant="secondary" active={intent === item.intent} onClick={() => setIntent(item.intent)}>
            {item.label}
          </Button>
        ))}
      </Container>
      <Container layout="horizontal" gap="sm" justifyContent="end" alignItems="center" wrap>
        {message ? (
          <Text variant="body-xs" color={message.endsWith('saved.') || message.endsWith('requested.') ? 'success' : 'warning'}>
            {message}
          </Text>
        ) : null}
        <Button type="button" variant="primary" onClick={request} disabled={!canRequest} loading={busy}>
          Compare clips
        </Button>
      </Container>
      {first ? (
        <Container layout="vertical" gap="sm">
          <Card variant="nested" padding="md">
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
              <Container layout="vertical" gap="xs">
                <Text variant="heading-lg" leading="tight">{first.request.sourceClip.label} vs {first.request.referenceClip.label}</Text>
                <Text variant="body-xs" color="faint">{first.factorSummary}</Text>
                <Text variant="body-xs" color="faint">{first.syncSummary}</Text>
              </Container>
              <Badge variant={first.status === 'matched' ? 'success' : first.status === 'no-match' ? 'warning' : 'info'} size="sm">
                {first.status}
              </Badge>
            </Container>
          </Card>
          {first.result ? (
            <Card variant="nested" padding="md">
              <Container layout="vertical" gap="sm">
                {renderVideoUrl ? (
                  <MediaFrame
                    url={renderVideoUrl}
                    mediaType="video/mp4"
                    label="Side-by-side comparison"
                  />
                ) : null}
                <Text variant="body">{first.result.tradeoffNote}</Text>
                <Textarea
                  placeholder="Coaching note"
                  rows={3}
                  value={note}
                  onChange={(event) => setNote(event.currentTarget.value)}
                />
                <Button type="button" variant="secondary" onClick={() => void attachNote(first)} disabled={!note.trim() || busy}>
                  Save coaching note
                </Button>
              </Container>
            </Card>
          ) : (
            <Text variant="body-xs" color="warning">Clips saved — but the video analysis engine is not connected to run here yet, so this will not produce a result.</Text>
          )}
        </Container>
      ) : null}
    </Container>
  );
}
