// package-set://bitfield-studio/packages/customer-support/show/field-value-view.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Two generic, data-driven presentation seams (L090):
//
//   • FieldValueView — render ONE field value as a shared atom. The record-work
//     graph carries field values as an opaque map (no `valueShape`), so this
//     renders the scalar as text and falls through to a faint placeholder when
//     empty. A new field renders with ZERO panel code change because panels ask
//     this helper instead of hand-rolling a row.
//
//   • StatusBadges — render a record's state refs through the shared status
//     vocabulary (statusView), so label + tone are DATA-driven. A new state is a
//     new ref string; no closed union, no `if (state === …)` anywhere.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Open dispatch: an unknown value/state still renders (text / statusView
//    fallback), never an error or blank.
// 2. Statuses resolve ONLY through statusView — no tone map, no closed enum here.
// 3. No raw HTML, no className — composes shared `ui` atoms only (L065/L066).
//
// =============================================================================

import React from 'react';
import { Badge, Container, Text, statusView } from '@/packages/ui';

/** Generic scalar → display string. Arrays/objects collapse to a count/marker. */
export function valueToText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? '' : String(value.length);
  return '';
}

export interface FieldValueViewProps {
  value: unknown;
}

/** Render one field value as a shared atom; faint dash when there is nothing. */
export function FieldValueView({ value }: FieldValueViewProps): React.ReactElement {
  const display = valueToText(value);
  if (display.length === 0) {
    return <Text variant="body-xs" color="faint">—</Text>;
  }
  return <Text variant="body">{display}</Text>;
}

export interface StatusBadgesProps {
  stateRefs: string[];
}

/** Render each state ref as a DATA-driven status badge (label + tone from data). */
export function StatusBadges({ stateRefs }: StatusBadgesProps): React.ReactElement | null {
  if (stateRefs.length === 0) return null;
  return (
    <Container layout="horizontal" gap="xs" wrap alignItems="center">
      {stateRefs.map((ref) => {
        const view = statusView(ref);
        return (
          <Badge key={ref} variant={view.tone} size="sm">{view.label}</Badge>
        );
      })}
    </Container>
  );
}
