// packages/workflow-canvas/show/WaitDurationEditor.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A generic amount + unit duration control. Wait-duration anatomy from the
// reference corpus (HoneyBook "1 + Days", Intercom "3d 0h 0m"): a small amount
// + a unit word, never raw seconds.
//
// The engine truth STAYS seconds — this is a pure translation boundary (L098):
// display unit = the largest unit that divides the stored value evenly; writes =
// amount × unit. A generic control primitive consumed by the blind
// StepFieldRenderer (control.kind === 'duration'); holds zero step-kind
// vocabulary.
//
// Extracted from NodeInspector.tsx so both the inspector and the generic
// StepFieldRenderer compose ONE definition (SSOT — never duplicated).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState } from 'react';
import { Container, Dropdown, Input } from '../../ui';

const WAIT_UNITS = [
  { value: '60', label: 'minutes' },
  { value: '3600', label: 'hours' },
  { value: '86400', label: 'days' },
  { value: '1', label: 'seconds' },
] as const;

/** The largest whole unit that divides `secs` evenly (display unit). */
export function waitUnitFor(secs: number): number {
  for (const unit of [86400, 3600, 60]) {
    if (secs > 0 && secs % unit === 0) return unit;
  }
  return 1;
}

/** Human duration for read-only display ("120" → "2 minutes"). Same unit
 *  translation as the editor; pure, so the blind read-only renderer reuses it. */
export function formatDuration(secs: number): string {
  const unit = waitUnitFor(secs);
  const amount = unit > 0 ? Math.round(secs / unit) : secs;
  const label = WAIT_UNITS.find((u) => Number(u.value) === unit)?.label ?? 'seconds';
  return `${amount} ${label}`;
}

export function WaitDurationEditor({ secs, onChange }: {
  secs: number;
  onChange: (secs: number) => void;
}): React.ReactElement {
  const [unit, setUnit] = useState(() => waitUnitFor(secs));
  const amount = unit > 0 ? Math.round(secs / unit) : secs;
  return (
    <Container layout="horizontal" gap="sm" alignItems="end" data-workflow-wait-duration="true">
      <Container flex={1}>
        <Input
          label="How long"
          value={String(amount)}
          onChange={(event) => {
            const next = Number(event.target.value);
            onChange(Number.isFinite(next) && next >= 0 ? Math.round(next) * unit : 0);
          }}
        />
      </Container>
      <Container flex={1}>
        <Dropdown
          aria-label="Wait unit"
          items={[...WAIT_UNITS]}
          value={String(unit)}
          onValueChange={(value) => {
            const nextUnit = Number(value);
            setUnit(nextUnit);
            onChange(amount * nextUnit);
          }}
        />
      </Container>
    </Container>
  );
}
