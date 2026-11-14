// package-set://bitfield-studio/packages/marketing-pipeline/show/record-collection.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The record-collection region: the center of the workbench. It groups records
// by the active view (DATA), shows a hairline scan row of per-group counts when
// there is more than one group, and lays the records out in the view's
// ARRANGEMENT — list, board, or table — chosen by an OPEN map with a `list`
// fallback. A new arrangement is a data value plus one map entry; adding one
// never edits the records, the grouping, or the selection logic.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic / Data-Driven Gate (L063/L090): arrangement dispatches through an
//    OPEN map keyed by `view.arrangement` with a `list` fallback — no closed
//    union, no `if (kind === …)`. Columns/fields iterate descriptor DATA; group
//    labels resolve through statusView. No domain term in code.
// 2. ONE grouping pass (SSOT): groups come from the pure groupRecords; the scan
//    counts are `group.records.length` — no second tally.
// 3. Honest counts (L117): the scan row reflects real records; one group → no
//    scan row (nothing to scan).
// 4. Composes shared `ui` only — no raw HTML, no className (L065/L066).
//
// =============================================================================

import React from 'react';
import {
  Card,
  Container,
  MetricRow,
  ScrollableSurface,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  statusView,
  type MetricCell,
} from '@/packages/ui';
import type {
  CoordinationFieldDescriptor,
  CoordinationSurfaceModel,
  CoordinationViewDescriptor,
} from '../read-data/read-coordination-records';
import { groupRecords, UNSORTED_GROUP_KEY } from '../read-data/coordination-metrics';
import { FieldValueView } from './field-value-view';
import { CoordinationFieldList } from './coordination-field-list';
import type { CoordinationRecord } from '../read-data/read-coordination-records';

interface DecoratedGroup {
  id: string;
  label: string;
  records: CoordinationRecord[];
}

interface ArrangementProps {
  groups: DecoratedGroup[];
  fields: CoordinationFieldDescriptor[];
  showGroupHeaders: boolean;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}

type Arrangement = (props: ArrangementProps) => React.ReactElement;

// --- One record card (shared by list + board) ------------------------------

function RecordCard({
  record,
  fields,
  selectedId,
  onSelect,
}: {
  record: CoordinationRecord;
  fields: CoordinationFieldDescriptor[];
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
      <Text variant="heading-lg">{record.label}</Text>
      <CoordinationFieldList fields={fields} record={record} />
    </Card>
  );
}

// --- list: vertical groups of stacked cards --------------------------------

const ListArrangement: Arrangement = ({ groups, fields, showGroupHeaders, selectedId, onSelect }) => (
  <Container layout="vertical" gap="md">
    {groups.map((group) => (
      <Container key={group.id} layout="vertical" gap="sm">
        {showGroupHeaders && group.label.length > 0 && (
          <Text variant="overline" color="muted">{group.label}</Text>
        )}
        {group.records.map((record) => (
          <RecordCard key={record.id} record={record} fields={fields} selectedId={selectedId} onSelect={onSelect} />
        ))}
      </Container>
    ))}
  </Container>
);

// --- board: side-by-side columns, one per group ----------------------------

const BoardArrangement: Arrangement = ({ groups, fields, selectedId, onSelect }) => (
  <ScrollableSurface>
    <Container layout="horizontal" gap="md" alignItems="start">
      {groups.map((group) => (
        <Container key={group.id} layout="vertical" gap="sm" minWidth="260px">
          <Container layout="horizontal" gap="xs" alignItems="center" justifyContent="between">
            <Text variant="overline" color="muted">{group.label || 'All'}</Text>
            <Text variant="caption" color="faint">{String(group.records.length)}</Text>
          </Container>
          {group.records.map((record) => (
            <RecordCard key={record.id} record={record} fields={fields} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </Container>
      ))}
    </Container>
  </ScrollableSurface>
);

// --- table: descriptor-driven columns, one row per record ------------------

function GroupTable({
  fields,
  records,
  selectedId,
  onSelect,
}: {
  fields: CoordinationFieldDescriptor[];
  records: CoordinationRecord[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}): React.ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {fields.map((field) => (
            <TableHead key={field.id}>{field.label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((record) => (
          <TableRow
            key={record.id}
            interactive
            selected={record.id === selectedId}
            onClick={() => onSelect(record.id)}
          >
            {fields.map((field) => (
              <TableCell key={field.id}>
                <FieldValueView valueShape={field.valueShape} value={record.fieldValues[field.id]} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const TableArrangement: Arrangement = ({ groups, fields, showGroupHeaders, selectedId, onSelect }) => (
  <Container layout="vertical" gap="md">
    {groups.map((group) => (
      <Container key={group.id} layout="vertical" gap="sm">
        {showGroupHeaders && group.label.length > 0 && (
          <Text variant="overline" color="muted">{group.label}</Text>
        )}
        <GroupTable fields={fields} records={group.records} selectedId={selectedId} onSelect={onSelect} />
      </Container>
    ))}
  </Container>
);

/** OPEN arrangement map — a new layout is one entry + a data value, no edit to
 *  the collection. Unknown/absent arrangement falls back to `list`. */
const ARRANGEMENTS: Record<string, Arrangement> = {
  list: ListArrangement,
  board: BoardArrangement,
  table: TableArrangement,
};

function arrangementFor(key: string | undefined): Arrangement {
  return (key ? ARRANGEMENTS[key] : undefined) ?? ListArrangement;
}

export interface RecordCollectionProps {
  model: CoordinationSurfaceModel;
  view: CoordinationViewDescriptor | undefined;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}

/** The center collection: scan row + the active view's arrangement of records. */
export function RecordCollection({ model, view, selectedId, onSelect }: RecordCollectionProps): React.ReactElement {
  const choiceFieldIds = React.useMemo(
    () => new Set(model.fields.filter((field) => field.valueShape === 'choice').map((field) => field.id)),
    [model.fields],
  );

  const labelForKey = React.useCallback(
    (key: string): string => {
      if (key === UNSORTED_GROUP_KEY) return 'Unsorted';
      return view?.groupBy && choiceFieldIds.has(view.groupBy) ? statusView(key).label : key;
    },
    [view?.groupBy, choiceFieldIds],
  );

  const groups = React.useMemo<DecoratedGroup[]>(
    () => groupRecords(model.records, view?.groupBy).map((group) => ({
      id: group.key,
      label: group.key === UNSORTED_GROUP_KEY && !view?.groupBy ? '' : labelForKey(group.key),
      records: group.records,
    })),
    [model.records, view?.groupBy, labelForKey],
  );

  const showGroupHeaders = groups.length > 1;
  const scanCells: MetricCell[] = showGroupHeaders
    ? groups.map((group) => ({ label: group.label || 'All', value: String(group.records.length) }))
    : [];

  const Arrange = arrangementFor(view?.arrangement);

  return (
    <Container as="section" layout="vertical" gap="md" flex="1" aria-label="Records">
      {scanCells.length > 0 && <MetricRow cells={scanCells} align="start" />}
      <Arrange
        groups={groups}
        fields={model.fields}
        showGroupHeaders={showGroupHeaders}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    </Container>
  );
}

export default RecordCollection;
