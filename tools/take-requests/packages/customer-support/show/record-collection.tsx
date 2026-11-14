// package-set://bitfield-studio/packages/customer-support/show/record-collection.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// WorkItemListView — the center of the workbench. A scannable list of record
// cards; each card shows the record's label, its DATA-driven state badges, and
// the active view's fields. A new record is a data row; a new field/column is a
// field row on the active view descriptor; a new state is a new ref. NONE of
// those touch this file — the Generic / Data-Driven Gate (L063/L090).
//
// This renderer is BLIND: it contains zero support vocabulary. It is handed a
// list of records + a view descriptor and renders whatever they describe, so
// the exact same component renders any record-work surface.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic / Data-Driven Gate (L063/L090): fields iterate the view's field
//    DATA; statuses resolve through statusView (via StatusBadges). No closed
//    union, no `if (kind === …)`, no domain term in code.
// 2. Honest counts (L117): the records shown are the real records passed in —
//    nothing synthesized, no fake "0 of N" shell.
// 3. Composes shared `ui` only — no raw HTML, no className (L065/L066).
//
// =============================================================================

import React from 'react';
import { Card, Container, Text } from '@/packages/ui';
import type { WorkDescriptor } from '../read-data/record-work-graph';
import type { SupportRecord } from './workspace-types';
import { RecordFieldList } from './record-field-list';
import { StatusBadges } from './field-value-view';

function RecordCard({
  record,
  fields,
  selectedId,
  onSelect,
}: {
  record: SupportRecord;
  fields: WorkDescriptor['fields'];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}): React.ReactElement {
  return (
    <Card
      variant="surface"
      padding="md"
      layout="stack"
      interactive
      selected={record.id === selectedId}
      onClick={() => onSelect(record.id)}
    >
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Text variant="heading-lg" truncate>{record.label}</Text>
        <StatusBadges stateRefs={record.stateRefs} />
      </Container>
      <RecordFieldList fields={fields ?? []} values={record.fields} />
    </Card>
  );
}

export interface RecordCollectionProps {
  records: SupportRecord[];
  /** The active view descriptor — supplies the field columns to show per card. */
  view: WorkDescriptor | undefined;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}

/** The center collection: a vertical list of selectable record cards. */
export function RecordCollection({ records, view, selectedId, onSelect }: RecordCollectionProps): React.ReactElement {
  return (
    <Container as="section" layout="vertical" gap="sm" flex="1" aria-label="Records">
      {records.map((record) => (
        <RecordCard
          key={record.id}
          record={record}
          fields={view?.fields}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </Container>
  );
}

export default RecordCollection;
