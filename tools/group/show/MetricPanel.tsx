// packages/group/show/MetricPanel.tsx
//
// The product surface for the metric primitive (read-data/board-metric): a popover that shows a goal's
// numeric progress and lets you move it — a progress bar + a remaining/over readout + a − / value / +
// stepper for the current value + set-current / set-target inputs + a clear. Generic + DATA-driven: it
// renders whatever metric it is handed and emits bump/set/clear; the mount commits the mutations. The
// two draft inputs hold ephemeral UI text only (not app truth — the graph is the SSOT), so they live in
// local state to keep the mount lean. L065: ui components only.

import React from 'react';
import { Button, Container, Input, ProgressBar, Text } from '../../ui';
import { type Metric, formatValue, isComplete, overBy, progressPct, remaining } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-metric.ts';

export interface MetricPanelProps {
  readonly metric: Metric;
  /** Move the current value by a delta (the ± stepper). */
  readonly onBump: (delta: number) => void;
  /** Jump the current value to an exact number. */
  readonly onSetCurrent: (value: number) => void;
  /** Change the target. */
  readonly onSetTarget: (value: number) => void;
  /** Remove the metric entirely. */
  readonly onClear: () => void;
  readonly onClose: () => void;
}

/** Parse a numeric input draft to a finite number, or null when blank/invalid. */
function parseNum(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function MetricPanel({ metric, onBump, onSetCurrent, onSetTarget, onClear, onClose }: MetricPanelProps): JSX.Element {
  const [currentDraft, setCurrentDraft] = React.useState('');
  const [targetDraft, setTargetDraft] = React.useState('');
  const done = isComplete(metric);
  const pct = progressPct(metric);
  const left = remaining(metric);
  const over = overBy(metric);
  const unitSuffix = metric.unit ? ` ${metric.unit}` : '';

  const commitCurrent = () => {
    const n = parseNum(currentDraft);
    if (n !== null) onSetCurrent(n);
    setCurrentDraft('');
  };
  const commitTarget = () => {
    const n = parseNum(targetDraft);
    if (n !== null) onSetTarget(n);
    setTargetDraft('');
  };

  // Surface + drag header + "Progress" title are owned by the AnchoredOverlay this
  // mounts inside (one surface, not a nested Card); this renders the body only.
  return (
    <Container layout="vertical" gap="sm" padding="md" style={{ minWidth: 280, maxWidth: 340 }}>
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Text variant="body-sm" tone="muted">{formatValue(metric)}</Text>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close progress panel">Close</Button>
      </Container>

      <ProgressBar percentage={pct} color={done ? 'var(--color-success, #16a34a)' : 'var(--accent-primary, #3b6fe0)'} />

      <Text variant="body-sm" tone={done ? undefined : 'muted'}>
        {done ? (over > 0 ? `Target beaten by ${over}${unitSuffix}` : 'Target reached') : `${left}${unitSuffix} to go · ${pct}%`}
      </Text>

      {/* The ± stepper — the fast one-tap way to log a unit of progress. */}
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Button variant="secondary" size="sm" onClick={() => onBump(-1)} aria-label="Decrease progress by one">−</Button>
        <Container style={{ flex: 1, textAlign: 'center' }}>
          <Text variant="body-md" weight="semibold">{`${metric.current}`}</Text>
        </Container>
        <Button variant="secondary" size="sm" onClick={() => onBump(1)} aria-label="Increase progress by one">+</Button>
      </Container>

      {/* Exact set: current value and target. */}
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Input
          value={currentDraft}
          onChange={(e) => setCurrentDraft(e.target.value)}
          placeholder={`Set value (${metric.current})`}
          aria-label="Set the current value"
        />
        <Button variant="ghost" size="sm" onClick={commitCurrent} disabled={parseNum(currentDraft) === null} aria-label="Apply the current value">Set</Button>
      </Container>
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Input
          value={targetDraft}
          onChange={(e) => setTargetDraft(e.target.value)}
          placeholder={`Set target (${metric.target})`}
          aria-label="Set the target"
        />
        <Button variant="ghost" size="sm" onClick={commitTarget} disabled={parseNum(targetDraft) === null} aria-label="Apply the target">Set</Button>
      </Container>

      <Button variant="ghost" size="sm" onClick={onClear} aria-label="Remove this metric">Remove metric</Button>
    </Container>
  );
}
