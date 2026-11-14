//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Two GENERIC shape editors registered into visual-database's field-editor
// registry: `scale` (a bounded numeric readout set with one drag) and `grid`
// (big-tap single-select over the descriptor's domain). Both are Physics — they
// carry NO domain vocabulary; the descriptor's DATA (shape + domain values)
// drives everything. The same two editors serve EVERY rating survey (NPS 0–10,
// CSAT 1–5, focus/mood/effort) — the instrument is DATA, never code.
//
// Isolated from field-editors.tsx (which drags the attachment/file CodeMirror
// graph) so these compose from `ui` primitives ONLY and unit-test in isolation.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO inline styling — every pixel is a `ui` primitive prop (L065/L066).
// 2. ZERO domain vocabulary — bounds, anchors, options, tone all arrive as the
//    descriptor's `domain` DATA. Delete the instrument DATA and the editor is
//    unchanged; drop a different survey's DATA in and it just works.
// 3. `scale` commits a NUMBER (measures aggregate it); `grid` commits the chosen
//    domain value id (same contract as `choice`), or null to clear.
// =============================================================================

import React from 'react';
import { Badge, Button, ColorDot, Container, Slider } from '../../ui';
import type { VisualDatabaseFieldDomainValue } from 'trillion-workshop/tools/keep-lists-of-rows/read-data/visual-database.ts';
import {
  domainValueColor,
  humanize,
  stop,
  type FieldEditorProps,
} from 'trillion-workshop/tools/keep-lists-of-rows/show/field-editor-kit.ts';

// -----------------------------------------------------------------------------
// Scale — bounds + endpoint anchors are DATA: the domain values ARE the scale
// stops (`order` = position, `label` = anchor). No domain → a 0–10 generic
// default (L083 max-capable default).
// -----------------------------------------------------------------------------
export function scaleBounds(domain: readonly VisualDatabaseFieldDomainValue[]): {
  min: number;
  max: number;
  minLabel: string;
  maxLabel: string;
  anchors: ReadonlyMap<number, string>;
} {
  const stops = domain
    .map((value) => ({ pos: Number(value.order), label: humanize(value.label) }))
    .filter((entry) => Number.isFinite(entry.pos))
    .sort((a, b) => a.pos - b.pos);
  if (stops.length === 0) {
    return { min: 0, max: 10, minLabel: '', maxLabel: '', anchors: new Map() };
  }
  const anchors = new Map<number, string>();
  for (const entry of stops) anchors.set(entry.pos, entry.label);
  const first = stops[0];
  const last = stops[stops.length - 1];
  return {
    min: first.pos,
    max: last.pos === first.pos ? first.pos + 1 : last.pos,
    minLabel: first.label,
    maxLabel: last.label,
    anchors,
  };
}

export function ScaleFieldEditor({ descriptor, value, domain, commit, readOnly }: FieldEditorProps) {
  // Scale BOUNDS are declared config (the endpoints), not discovered data — read
  // the descriptor's own domain values, never the effective `domain` prop, which
  // merges in observed record values (each an ad-hoc stop that would blow up the
  // range). The `domain` prop is the right source for the grid's OPTIONS, not for
  // a continuum's endpoints.
  const declared = descriptor.domain?.values;
  const { min, max, minLabel, maxLabel, anchors } = scaleBounds(declared && declared.length > 0 ? declared : domain);
  const numeric =
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : value === null || value === undefined || value === ''
        ? null
        : Number(value);
  const hasValue = numeric !== null && Number.isFinite(numeric);
  const current = hasValue ? (numeric as number) : Math.round((min + max) / 2);
  const anchorLabel = anchors.get(current);
  const valueLabel = anchorLabel ? `${current} · ${anchorLabel}` : String(current);
  if (readOnly) {
    if (!hasValue) return null;
    return <Badge variant="muted">{valueLabel}</Badge>;
  }
  const description = minLabel || maxLabel ? `${minLabel} → ${maxLabel}` : undefined;
  return (
    <Container padding="none" minHeight="0" onClick={stop}>
      <Slider
        label={humanize(descriptor.label)}
        description={description}
        value={current}
        min={min}
        max={max}
        step={1}
        valueLabel={valueLabel}
        onValueChange={(next) => commit(next)}
      />
    </Container>
  );
}

// -----------------------------------------------------------------------------
// Grid — big-tap single-select over the descriptor's domain. Same DATA and same
// commit as choice (`candidate.id`), rendered as full-size tap cells instead of
// a dropdown: the -1000IQ one-tap check-in (mood / effort / where-did-it-land).
// Tap a cell to select; tap the active cell to clear.
// -----------------------------------------------------------------------------
export function GridFieldEditor({ value, domain, commit, readOnly }: FieldEditorProps) {
  const stored = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  const [optimistic, setOptimistic] = React.useState<string | null>(null);
  React.useEffect(() => { setOptimistic(null); }, [stored]);
  const current = optimistic ?? stored;
  if (readOnly) {
    const entry = domain.find((candidate) => candidate.id === current);
    if (!current || !entry) return null;
    return (
      <Badge variant="muted">
        <ColorDot color={domainValueColor(entry)} size="xs" />
        {humanize(entry.label)}
      </Badge>
    );
  }
  return (
    <Container layout="horizontal" wrap gap="sm" padding="none" minHeight="0" onClick={stop}>
      {domain.map((candidate) => {
        const selected = candidate.id === current;
        return (
          <Button
            key={candidate.id}
            variant={selected ? 'primary' : 'outline'}
            size="md"
            aria-label={humanize(candidate.label)}
            aria-pressed={selected}
            onClick={(event: React.MouseEvent) => {
              event.stopPropagation();
              const next = selected ? '' : candidate.id;
              setOptimistic(next);
              commit(next.length > 0 ? next : null);
            }}
          >
            <ColorDot color={domainValueColor(candidate)} size="xs" />
            {humanize(candidate.label)}
          </Button>
        );
      })}
    </Container>
  );
}
