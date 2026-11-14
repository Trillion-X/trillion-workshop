// package-set://bitfield-studio/packages/marketing-pipeline/show/field-value-view.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// ONE generic renderer for a single field value, dispatched by the field's
// `valueShape` (DATA from the field descriptor). This is the L090 data-driven
// presentation seam: a new field renders with ZERO panel code change because
// the panel asks this helper, and an UNKNOWN shape still renders (falls through
// to plain text). The shape vocabulary is generic presentation kinds
// (text/choice/person/date/number) — never marketing outcomes.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Open dispatch: unknown `valueShape` → plain Text, never an error or blank.
// 2. `choice` values render through the shared status vocabulary, so the
//    label/tone is data-driven (statusView), not a closed enum in this file.
// 3. No raw HTML, no className — composes shared `ui` atoms only (L065).
//
// =============================================================================

import React from 'react';
import { Badge, PersonTag, Text, statusView } from '@/packages/ui';

/** Generic scalar → display string. Arrays/objects collapse to a count/marker. */
export function valueToText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? '' : `${value.length}`;
  return '';
}

export interface FieldValueViewProps {
  valueShape: string;
  value: unknown;
}

/** Render one field value as the shared atom that fits its presentation shape. */
export function FieldValueView({ valueShape, value }: FieldValueViewProps): React.ReactElement {
  const display = valueToText(value);

  if (display.length === 0) {
    return <Text variant="body-xs" color="faint">—</Text>;
  }

  switch (valueShape) {
    case 'person': {
      return <PersonTag name={display} showName size="sm" />;
    }
    case 'choice': {
      const view = statusView(display);
      return <Badge variant={view.tone} size="sm">{view.label}</Badge>;
    }
    default: {
      return <Text variant="body">{display}</Text>;
    }
  }
}
