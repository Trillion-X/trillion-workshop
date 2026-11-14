// package-set://bitfield-studio/packages/marketing-pipeline/show/coordination-field-list.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Render a record's fields as DATA rows. The panel never names a field — it
// iterates `fields` (descriptor DATA, already ordered) and renders each through
// FieldValueView. Adding/removing/reordering a field is a data change with
// ZERO edits here (the Generic / Data-Driven Gate, L063/L090).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Fields are iterated from DATA — no hand-rolled per-field row, no field
//    name in code.
// 2. Composes shared `ui` atoms only — no raw HTML, no className (L065).
// 3. A field with no value still renders its label (FieldValueView shows a
//    faint placeholder), so the record's shape stays legible.
//
// =============================================================================

import React from 'react';
import { Container, Text } from '@/packages/ui';
import type {
  CoordinationFieldDescriptor,
  CoordinationRecord,
} from '../read-data/read-coordination-records';
import { FieldValueView } from './field-value-view';

export interface CoordinationFieldListProps {
  fields: CoordinationFieldDescriptor[];
  record: CoordinationRecord;
}

/** A labeled value list for one record, driven entirely by field DATA. */
export function CoordinationFieldList({ fields, record }: CoordinationFieldListProps): React.ReactElement | null {
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
            <FieldValueView valueShape={field.valueShape} value={record.fieldValues[field.id]} />
          </Container>
        </Container>
      ))}
    </Container>
  );
}
