// package-set://bitfield-studio/packages/customer-support/show/record-field-list.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Render a record's fields as DATA rows. The panel never names a field — it
// iterates `fields` (the active view's field descriptors, already ordered) and
// reads each value from the record's opaque field map through FieldValueView.
// Adding/removing/reordering a field is a data change (a field row on the view
// descriptor) with ZERO edits here — the Generic / Data-Driven Gate (L063/L090).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Fields are iterated from DATA — no hand-rolled per-field row, no field
//    name in code.
// 2. Composes shared `ui` atoms only — no raw HTML, no className (L065/L066).
// 3. A field with no value still renders its label (FieldValueView shows a
//    faint placeholder), so the record's shape stays legible.
//
// =============================================================================

import React from 'react';
import { Container, Text } from '@/packages/ui';
import type { RecordMap } from '../read-data/record-work-graph';
import { FieldValueView } from './field-value-view';

/** A single field column declared on a view descriptor. */
export interface ViewField {
  id: string;
  label: string;
  order: number;
}

export interface RecordFieldListProps {
  fields: ViewField[];
  /** The record's opaque field map (fieldId → value). */
  values: RecordMap;
}

/** A labeled value list for one record, driven entirely by field DATA. */
export function RecordFieldList({ fields, values }: RecordFieldListProps): React.ReactElement | null {
  if (fields.length === 0) return null;

  return (
    <Container as="dl" layout="vertical" gap="xs">
      {fields.map((field) => (
        <Container
          key={field.id}
          layout="horizontal"
          gap="sm"
          alignItems="center"
          justifyContent="between"
        >
          <Text as="dt" variant="label" color="muted">{field.label}</Text>
          <Container as="dd" layout="horizontal" gap="xs" alignItems="center">
            <FieldValueView value={values[field.id]} />
          </Container>
        </Container>
      ))}
    </Container>
  );
}

export default RecordFieldList;
