// packages/group/show/TimeLogPanel.tsx
//
// The product surface for the time-log primitive (read-data/board-time-log): a popover that shows how
// much effort an item has taken and lets you add more — a total + session count + last-worked line, a
// live Start/Stop timer, quick-add buttons (+15m/+25m/+60m), remove-last, and clear. Generic +
// DATA-driven: it renders the totals it is handed and emits log/quick-add/remove/clear; the mount
// commits the mutations. The running-timer start is ephemeral UI state (not app truth — the graph is
// the SSOT; a completed session is appended on Stop), so it lives in local state. L065: ui only.

import React from 'react';
import { Button, Container, Text } from '../../ui/index.ts';
import { useElapsedSeconds, formatElapsed } from './use-elapsed.ts';

/** The quick-add increments (minutes) — DATA, not hardcoded per-button branches. */
const QUICK_ADD_MINUTES: readonly number[] = [15, 25, 60];

export interface TimeLogPanelProps {
  /** Human total, e.g. "2h 30m". */
  readonly totalLabel: string;
  readonly sessions: number;
  /** Human "time since last worked", e.g. "2h" — omitted when nothing is logged. */
  readonly lastAgoLabel?: string;
  /** Append a completed session (the live-timer Stop hands back start + duration). */
  readonly onLogSession: (startMs: number, durationMs: number) => void;
  /** Quick-add N minutes ending now. */
  readonly onQuickAdd: (minutes: number) => void;
  readonly onRemoveLast: () => void;
  readonly onClear: () => void;
  readonly onClose: () => void;
}

export function TimeLogPanel({
  totalLabel,
  sessions,
  lastAgoLabel,
  onLogSession,
  onQuickAdd,
  onRemoveLast,
  onClear,
  onClose,
}: TimeLogPanelProps): JSX.Element {
  const [runningStartMs, setRunningStartMs] = React.useState<number | null>(null);
  // The SAME live-elapsed primitive the in-flight producer card uses (SSOT) — so the
  // running timer VISIBLY ticks up every second instead of a dead "Recording…" label.
  const elapsedSeconds = useElapsedSeconds(runningStartMs);

  const startTimer = () => setRunningStartMs(Date.now());
  const stopTimer = () => {
    if (runningStartMs === null) return;
    const durationMs = Date.now() - runningStartMs;
    setRunningStartMs(null);
    if (durationMs > 0) onLogSession(runningStartMs, durationMs);
  };

  // Surface + drag header + "Time" title are owned by the AnchoredOverlay this mounts
  // inside (one surface, not a nested Card); this renders the body only.
  return (
    <Container layout="vertical" gap="sm" padding="md" style={{ minWidth: 260, maxWidth: 320 }}>
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Text variant="body-sm" tone="muted">{`${totalLabel} · ${sessions} ${sessions === 1 ? 'session' : 'sessions'}`}</Text>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close time panel">Close</Button>
      </Container>

      {lastAgoLabel ? <Text variant="body-sm" tone="muted">{`Last worked ${lastAgoLabel} ago`}</Text> : null}

      {/* Live timer — the honest way to capture real effort. Start captures now; the
          label ticks the real elapsed each second; Stop logs it. */}
      {runningStartMs === null ? (
        <Button variant="primary" size="sm" onClick={startTimer} aria-label="Start a work timer">Start timer</Button>
      ) : (
        <Button variant="secondary" size="sm" onClick={stopTimer} aria-label="Stop the work timer and log it">
          {`Recording ${formatElapsed(elapsedSeconds ?? 0)} · tap to stop`}
        </Button>
      )}

      {/* Quick-add — log a known chunk without timing it. DATA-driven rows (L090). */}
      <Container layout="horizontal" gap="sm" alignItems="center">
        {QUICK_ADD_MINUTES.map((m) => (
          <Button key={m} variant="secondary" size="sm" onClick={() => onQuickAdd(m)} aria-label={`Log ${m} minutes`}>
            {`+${m}m`}
          </Button>
        ))}
      </Container>

      <Container layout="horizontal" gap="sm" alignItems="center">
        <Button variant="ghost" size="sm" onClick={onRemoveLast} disabled={sessions === 0} aria-label="Remove the last logged session">Undo last</Button>
        <Button variant="ghost" size="sm" onClick={onClear} disabled={sessions === 0} aria-label="Clear all logged time">Clear</Button>
      </Container>
    </Container>
  );
}
