// packages/motion-analysis/show/CaptureAndAnalyzeSurface.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The -1000IQ one-thing-on-screen capture→analyze→stats surface: a full-bleed
// live view with ONE giant control (Start → record → Stop), a brief working
// state, then the result. This is the SwingVision "press Start, play, pull the
// phone down, press Stop, instantly see your stats" screen — but it is GENERIC:
// it owns NO camera glue, NO dispatch, NO domain vocabulary, NO model paths.
//
// It is PURELY PRESENTATIONAL + a state machine driven by props:
//   - `cameraSlot`  : the live preview node (the parent supplies the <video> /
//                     MediaFrame bound to the capture stream) — kept out so this
//                     surface stays testable and free of raw media elements.
//   - `resultView`  : what to show once analysis completes (the parent passes the
//                     visual-database match-stats view) — DATA-configured.
//   - `onStart`/`onStop` : the parent's capture+dispatch glue. On Stop the parent
//                     saves the clip and dispatches the configured analyze action
//                     (e.g. action:run-match-perception-and-stats) — the action id,
//                     the perception model paths (TrackerDescriptor DATA) and the
//                     view all live OUTSIDE this component (Society).
//
// The four stages are configurations of ONE surface (L063/L069); the verbs and
// the working line are neutral-defaulted PROPS (domain copy stays Society). All
// chrome composes ui primitives + CaptureControl — zero raw elements, zero
// feature-code className (L065/L066); the surface fills its parent.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

import { CaptureControl, type CaptureControlState } from '@/packages/ui/show/capture-control/CaptureControl';
import { Button } from '@/packages/ui/show/button';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';

/** The surface stage. Closed by Physics (a capture→analyze flow is either
 *  not-started, recording, analyzing, or showing its result / an error) — not
 *  extensible by Society, so an enum is correct here. */
export type CaptureAndAnalyzeStage = 'idle' | 'recording' | 'working' | 'result' | 'error';

export interface CaptureAndAnalyzeSurfaceProps {
  stage: CaptureAndAnalyzeStage;
  /** Elapsed capture time (ms) — rendered as the recording timer pill. */
  elapsedMs?: number;
  /** Live preview node (parent binds it to the capture stream). Shown in idle/recording/working. */
  cameraSlot?: React.ReactNode;
  /** Result content (e.g. the stats dashboard). Shown in the `result` stage. */
  resultView?: React.ReactNode;
  /** Begin capture (idle → recording). Also the retry action in the error stage. */
  onStart?: () => void;
  /** End capture and start analysis (recording → working). */
  onStop?: () => void;
  /** Human-language error line (error stage). Internal detail never shown here. */
  errorMessage?: string;
  /** Neutral-default verbs / working line — the parent supplies domain copy. */
  startLabel?: string;
  stopLabel?: string;
  workingLabel?: string;
  /** Label for the error-stage retry control. */
  retryLabel?: string;
}

const STAGE_TO_CONTROL: Record<'idle' | 'recording' | 'working', CaptureControlState> = {
  idle: 'idle',
  recording: 'recording',
  working: 'working',
};

/**
 * The full-screen capture→analyze→result surface. One screen, one control, four
 * stages. Presentational: capture + dispatch live in the parent's glue. Fills
 * its parent container.
 */
export function CaptureAndAnalyzeSurface({
  stage,
  elapsedMs,
  cameraSlot,
  resultView,
  onStart,
  onStop,
  errorMessage,
  startLabel = 'Start',
  stopLabel = 'Stop',
  workingLabel = 'Working…',
  retryLabel = 'Try again',
}: CaptureAndAnalyzeSurfaceProps) {
  // Result: the camera and control step aside; the result owns the screen.
  if (stage === 'result') {
    return (
      <Container height="full" width="full" data-capture-analyze="result">
        {resultView}
      </Container>
    );
  }

  // Error: one human line + a single retry. No stack trace, no internal detail.
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
        <Text variant="body" color="muted">
          {errorMessage ?? 'Something went wrong. Try again.'}
        </Text>
        <Button variant="accent" onClick={onStart}>
          {retryLabel}
        </Button>
      </Container>
    );
  }

  // idle / recording / working: full-bleed camera with the one giant control
  // overlaid at the bottom-center.
  return (
    <Container position="relative" overflow="hidden" height="full" width="full" data-capture-analyze={stage}>
      <Container position="absolute" inset="0" data-capture-analyze-camera>
        {cameraSlot}
      </Container>
      <Container
        position="absolute"
        inset="0"
        layout="vertical"
        alignItems="center"
        justifyContent="end"
        padding="xl"
        pointerEvents="none"
      >
        <Container alignItems="center" pointerEvents="auto">
          <CaptureControl
            state={STAGE_TO_CONTROL[stage]}
            elapsedMs={elapsedMs}
            onStart={onStart}
            onStop={onStop}
            startLabel={startLabel}
            stopLabel={stopLabel}
            workingLabel={workingLabel}
          />
        </Container>
      </Container>
    </Container>
  );
}

CaptureAndAnalyzeSurface.displayName = 'CaptureAndAnalyzeSurface';
