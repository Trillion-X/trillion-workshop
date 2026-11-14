// packages/ui/show/capture-control/CaptureControl.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The ONE shared molecule for a full-bleed "press to start / press to stop"
// capture control — a single giant circular button whose meaning is driven by
// one `state` prop (idle | recording | working), with an elapsed-time pill
// while recording and a quiet working line in between. This is the -1000IQ
// one-thing-on-screen control behind every record experience (Strava START,
// CapCut/Slack/YouTube stop): ONE button, ONE verb, nothing competing.
//
// It is PURELY PRESENTATIONAL. It owns NO capture logic, NO MediaStream, NO
// MediaRecorder, NO workflow dispatch. The owning surface holds the capture
// session and passes `state` + `elapsedMs` down and `onStart`/`onStop` up.
// That is what lets the SAME control serve audio capture, video capture, and
// the SwingVision match capture without the control knowing any of their
// domains (L069 generative primitive; the three states are configurations of
// one control, not three buttons — L063).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No domain vocabulary. Verbs ("Start"/"Stop") and the working line are
//    PROPS with neutral defaults; product-specific copy is supplied by the
//    surface (Society), never baked here (Physics). (Physics vs Society)
// 2. All color comes from token-bearing ui components (Button variant, Text
//    color, Badge variant). className is LAYOUT ONLY (flex/gap/size/rounded/
//    absolute) — never bg-*/text-*/border-* color. (L065/L066)
// 3. Self-describing label, no helper subcopy. The verb IS the explanation.
//    (L114/L115)
// 4. Given `readElapsedMs`, the time is read from the caller's own record of
//    when the capture started and how long it was paused, every time it is
//    drawn, and only the time redraws itself: a page busy scrolling, a
//    throttled timer or a hidden tab can delay a drawing but never make the
//    time fall behind, and the surface is not redrawn to move the clock.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Circle, Square } from 'lucide-react';

import { Badge } from '../badge';
import { Button } from '../button';
import { Container } from '../container';
import { Icon } from '../icon';
import { Spinner } from '../spinner';
import { Text } from '../text';
import { cn } from '../cn';

/** The three states of a capture control — a closed set by Physics (a capture
 *  is either not-started, running, or being finalized). Not extensible by
 *  Society, so an enum here is correct (not an enum-dissolution violation). */
export type CaptureControlState = 'idle' | 'recording' | 'working';

export interface CaptureControlProps {
  /** Which face the control shows. */
  state: CaptureControlState;
  /** Elapsed capture time in ms; rendered as a mm:ss pill while recording. */
  elapsedMs?: number;
  /** Reads the elapsed capture time in ms whenever the pill is drawn; when given, the pill redraws itself (while
   *  `ticking`) instead of waiting for `elapsedMs`. */
  readElapsedMs?: () => number;
  /** Whether the time is moving (recording, not paused). */
  ticking?: boolean;
  /** Press handler for the idle → recording transition. */
  onStart?: () => void;
  /** Press handler for the recording → working/stop transition. */
  onStop?: () => void;
  /** Disable the button (e.g. permission pending). */
  disabled?: boolean;
  /** Verb shown under the idle button. Neutral default; surface supplies domain copy. */
  startLabel?: string;
  /** Verb shown under the recording button. */
  stopLabel?: string;
  /** Quiet line shown in the working state. */
  workingLabel?: string;
  /** Layout-only className (positioning within the surface). */
  className?: string;
}

/** Format elapsed milliseconds as mm:ss (clamped at 0). */
export function formatElapsed(elapsedMs: number | undefined): string {
  const totalSeconds = Math.max(0, Math.floor((elapsedMs ?? 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** The running time, read from `read` each time it is drawn. It redraws itself four times a second while `ticking`,
 *  and at once whenever the page was scrolled or shown again, so a delayed drawing catches up immediately. */
export function ElapsedTime({ read, ticking }: { read: () => number; ticking: boolean }) {
  const [, redraw] = React.useReducer((count: number) => count + 1, 0);
  React.useEffect(() => {
    redraw();
    if (!ticking) return undefined;
    const timer = window.setInterval(redraw, 250);
    const now = () => redraw();
    window.addEventListener('scroll', now, { capture: true, passive: true });
    document.addEventListener('visibilitychange', now);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('scroll', now, { capture: true });
      document.removeEventListener('visibilitychange', now);
    };
  }, [ticking, read]);
  return <Text variant="caption" data-capture-elapsed="">{formatElapsed(read())}</Text>;
}

/**
 * A single giant circular capture control. One button, one verb, three states.
 *
 * @example
 * <CaptureControl state="idle" onStart={begin} startLabel="Start" />
 * <CaptureControl state="recording" elapsedMs={14000} onStop={end} stopLabel="Stop" />
 * <CaptureControl state="working" workingLabel="Reading your game…" />
 */
function CaptureControl({
  state,
  elapsedMs,
  readElapsedMs,
  ticking = true,
  onStart,
  onStop,
  disabled = false,
  startLabel = 'Start',
  stopLabel = 'Stop',
  workingLabel = 'Working…',
  className,
}: CaptureControlProps) {
  // Working: no button — a quiet spinner + one line. Nothing to press.
  if (state === 'working') {
    return (
      <Container
        className={cn('flex flex-col items-center justify-center gap-3', className)}
        data-capture-control="working"
      >
        <Spinner />
        <Text variant="body" color="muted">
          {workingLabel}
        </Text>
      </Container>
    );
  }

  const recording = state === 'recording';
  const verb = recording ? stopLabel : startLabel;

  return (
    <Container
      className={cn('flex flex-col items-center justify-center gap-3', className)}
      data-capture-control={state}
    >
      {/* Timer pill — only while recording; red dot + mm:ss (CapCut/Slack/YouTube). */}
      {recording && (
        <Badge variant="error" className="flex items-center gap-1.5">
          <Text variant="caption" color="error" aria-hidden>
            ●
          </Text>
          {readElapsedMs
            ? <ElapsedTime read={readElapsedMs} ticking={ticking} />
            : <Text variant="caption">{formatElapsed(elapsedMs)}</Text>}
        </Badge>
      )}

      {/* The one giant circular control. Variant carries color; className is
          layout-only (size + perfect circle). */}
      <Button
        variant={recording ? 'danger' : 'accent'}
        onClick={recording ? onStop : onStart}
        disabled={disabled}
        aria-label={verb}
        className="w-20 h-20 rounded-full p-0 flex items-center justify-center"
      >
        {recording
          ? <Icon icon={Square} size="xl" />
          : <Icon icon={Circle} size="xl" color="error" fill="currentColor" />}
      </Button>

      {/* Self-describing verb. No helper subcopy. */}
      <Text variant="label">{verb}</Text>
    </Container>
  );
}

CaptureControl.displayName = 'CaptureControl';

export { CaptureControl };
