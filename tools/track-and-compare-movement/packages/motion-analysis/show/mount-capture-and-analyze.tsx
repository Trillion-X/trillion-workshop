// packages/motion-analysis/show/mount-capture-and-analyze.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The SwingVision "Track my match" surface entry: drop/choose a match clip →
// "Reading your game…" → the stats appear. One thing on screen at every step
// (-1000IQ). It owns NO perception, NO measure, NO dashboard logic — it composes
// existing package capabilities by Envelope address + DATA:
//
//   • the perception runner is DATA: a TrackerDescriptor record read from the log,
//     selected by `surfaceInput.tracker_id` on the placeable-surface record —
//     this file names NO machine path / model / sport / tracker id.
//   • the clip → log via `stageContentMediaFile` (content-media-evidence owns it).
//   • the run is ONE dispatch of `action:run-match-perception-and-stats` via
//     `requestMatchPerception` (perception → measures → match-stat).
//   • the result is the visual-database surface mounted INLINE by address via
//     `SourceBytesScreenMount` (zero code import of that package) fed THIS match's
//     `{records, fields, views, actions}` through `surfaceInput` — so it never
//     clobbers the shared visual database.
//
// The session knows it finished by WATCHING the published-record stream for the
// emitted match-stat (the SSOT), not by parsing the workflow response.
//
// SCOPE: this is the clip path — the real loop for desktop/studio AND hosted-web
// (browser file input; the native camera bridge is desktop-only). The live-camera
// record path (getUserMedia + MediaRecorder, the phone-native State A/B) reuses
// `CaptureAndAnalyzeSurface` and is the next unit, gated on extracting a shared
// `useRecordingSession` hook from record-video (no recording-session
// duplication = no god package; tracked in the plan).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  Container,
  ErrorBoundary,
  SourceBytesScreenMount,
  Spinner,
  Text,
  mountReactSurface,
} from '@/packages/ui';
import { Button } from '@/packages/ui/show/button';
import { FileWorkAction } from '@/packages/ui/show/file-work-action';
import { FloatingMaterialFrame } from '@/packages/ui/show/floating-material-frame';
import {
  createContentMediaWorkId,
  stageContentMediaFile,
  type ContentMediaSourceRef,
} from '@/packages/content-media-evidence/do-work/content-media-work-loop';
import { requestMatchPerception } from '@/packages/motion-analysis/do-work/request-match-perception';
import {
  buildResultSurfaceInput,
  findMatchStat,
  readMatchStatsView,
  readTrackerDescriptor,
} from '@/packages/motion-analysis/read-data/read-capture-context';

/** Which perception tracker + stats view this surface uses arrives as surface
 *  DATA (`surfaceInput.tracker_id` / `surfaceInput.view_id` on the placeable-
 *  surface record) — this source names NO sport and NO tracker. A second sport
 *  is a new surface record, zero source change. Missing ids fail closed into
 *  the existing "isn’t set up" state. */
function surfaceDataId(props: Record<string, unknown>, key: string): string | null {
  const carrier = props.surfaceInput;
  if (!carrier || typeof carrier !== 'object' || Array.isArray(carrier)) return null;
  const value = (carrier as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const TRACKER_INPUT = 'tracker-descriptor';
const VIEW_INPUT = 'match-stats-view';
const RECORD_BY_ADDRESS_INPUT = 'record-by-address';
const VISUAL_DATABASE_ENTRY_BYTES = 'package::visual-database::entry-bytes::visual-database';

/** The log address a match-stat record lands at (composite `write_stat` step). */
function matchStatAddress(statId: string): string {
  return `package::progression-evaluator::match-stat::${statId}`;
}

type Stage = 'idle' | 'working' | 'result' | 'error';

function CaptureAndAnalyzeMaterial({ props }: { props: Record<string, unknown> }) {
  // Targeted single-address reads (NOT the bulk record-table input, which the
  // current engine projects from an RTBL the cell_table reader can't parse — a
  // shared infra issue). Each input resolves one address to JSON.
  const trackerRaw = useBitfieldData(TRACKER_INPUT);
  const viewRaw = useBitfieldData(VIEW_INPUT);
  const visualDatabaseBytes = useBitfieldData<Uint8Array>(
    React.useMemo(
      () => ({ input: 'package-entry-by-address-label', params: { addressLabel: VISUAL_DATABASE_ENTRY_BYTES } }),
      [],
    ),
  );

  const [stage, setStage] = React.useState<Stage>('idle');
  const [statId, setStatId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  // Watch this session's match-stat address. Before a clip is picked we still
  // must call the hook (rules of hooks), so we point at a valid-shaped address
  // for a record that does not exist — it resolves to "no record" (null), NOT an
  // empty address (which would fall through to a default record-table projection
  // and throw "column 0 out of bounds").
  const statRaw = useBitfieldData(
    React.useMemo(
      () => ({ input: RECORD_BY_ADDRESS_INPUT, params: { address: matchStatAddress(statId ?? '__pending__') } }),
      [statId],
    ),
  );

  const trackerId = surfaceDataId(props, 'tracker_id');
  const viewId = surfaceDataId(props, 'view_id');
  const tracker = React.useMemo(
    () => (trackerId ? readTrackerDescriptor(trackerRaw, trackerId) : null),
    [trackerRaw, trackerId],
  );
  const view = React.useMemo(
    () => (viewId ? readMatchStatsView(viewRaw, viewId) : null),
    [viewRaw, viewId],
  );
  const stat = React.useMemo(() => (statId ? findMatchStat(statRaw, statId) : null), [statRaw, statId]);
  const resultInput = React.useMemo(() => buildResultSurfaceInput(view, stat), [view, stat]);

  // The run finished when this session's match-stat lands in the log (the SSOT).
  React.useEffect(() => {
    if (stage === 'working' && resultInput) setStage('result');
  }, [stage, resultInput]);

  const onPick = React.useCallback(
    async (file: File) => {
      if (!tracker) {
        setErrorMessage('This isn’t set up to read your game yet.');
        setStage('error');
        return;
      }
      setBusy(true);
      setErrorMessage(null);
      try {
        const source = (await stageContentMediaFile({ packageName: 'motion-analysis', file })) as ContentMediaSourceRef;
        const sessionId = createContentMediaWorkId('match');
        setStatId(sessionId);
        setStage('working');
        // Fire the composite; the result transition is driven by the record watch
        // above, so we only need to catch a dispatch failure here.
        void requestMatchPerception({
          sources: [source],
          tracker,
          requestId: sessionId,
          statId: sessionId,
          statLabel: 'This match',
        }).catch(() => {
          setErrorMessage('Couldn’t read that clip — try again with the full court in frame.');
          setStage('error');
        });
      } catch {
        setErrorMessage('That clip couldn’t be added. Try another.');
        setStage('error');
      } finally {
        setBusy(false);
      }
    },
    [tracker],
  );

  const reset = React.useCallback(() => {
    setStatId(null);
    setErrorMessage(null);
    setStage('idle');
  }, []);

  if (stage === 'result') {
    return (
      <Container height="full" width="full" data-capture-analyze="result">
        <SourceBytesScreenMount
          sourceBytes={visualDatabaseBytes}
          sourceKey={VISUAL_DATABASE_ENTRY_BYTES}
          mountProps={{ floating_frame: { mode: 'inline' }, surfaceInput: resultInput }}
        />
      </Container>
    );
  }

  if (stage === 'working') {
    return (
      <Container
        layout="vertical"
        alignItems="center"
        justifyContent="center"
        gap="lg"
        height="full"
        width="full"
        data-capture-analyze="working"
      >
        <Spinner />
        <Text variant="body" color="muted">Reading your game…</Text>
      </Container>
    );
  }

  if (stage === 'error') {
    return (
      <Container
        layout="vertical"
        alignItems="center"
        justifyContent="center"
        gap="lg"
        height="full"
        width="full"
        data-capture-analyze="error"
      >
        <Text variant="body" color="muted">{errorMessage ?? 'Something went wrong. Try again.'}</Text>
        <Button variant="accent" onClick={reset}>Try again</Button>
      </Container>
    );
  }

  // idle: one full-bleed "Track my match" zone — drop or choose a clip.
  return (
    <Container
      layout="vertical"
      alignItems="center"
      justifyContent="center"
      gap="md"
      height="full"
      width="full"
      data-capture-analyze="idle"
    >
      <FileWorkAction
        accept="video/*"
        acceptsFile={(file) => file.type.startsWith('video/')}
        busy={busy}
        startWhenFilesAccepted
        showStartAction={false}
        emptyTitle="Track my match"
        emptyDetail="Drop your match video or choose one — get your stats"
        pickLabel="Choose video"
        startLabel="Track"
        rejectMessage="Choose a video file."
        errorMessage={errorMessage ?? undefined}
        onStart={onPick}
      />
    </Container>
  );
}

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(
    el,
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Track my match">
        <CaptureAndAnalyzeMaterial props={props} />
      </ErrorBoundary>
    </FloatingMaterialFrame>,
  );
}
