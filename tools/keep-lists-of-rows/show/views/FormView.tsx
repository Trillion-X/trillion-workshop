// parts/visual-database/show/views/FormView.tsx
//
// PURPOSE
//   The `form` view kind: any list's records filled in one at a time, the way a sign-up, intake or questions page
//   asks them. Each record is a page: its name as the question, then every field a person can fill, each through the
//   same field editors every view uses (a text field as an open box, since a form is for typing). Back and Next walk
//   the records the list shows after its search and filters; the form opens on the first record still missing a
//   value, and after the last one the surface's own composer adds a new record (a person's own answer or row).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: it names no list, field or value. Which fields are asked, in which order, is the list's own field order;
//      which records are walked is whatever the list shows (search, filters, saved views all compose with it).
//   2. One writer: every value is written through writeField (the same road FieldControl takes); a read-only list
//      draws the form with nothing to change.
//   3. Nothing is kept here but which record is open: the record's values are always the list's current ones.

import React from 'react';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { Button, Container, EmptyPlaceholder, Icon, ProgressBar, Text, Textarea } from '../../../ui';
import { FieldControl, canEditRecord, displayTitle, reportFailure, writeField } from '../field-editors';
import {
  deriveShape,
  extractFieldValue,
  recordAddress,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseLaneDescriptor,
  type VisualDatabaseModel,
  type VisualDatabaseRecord,
  type VisualDatabaseViewDescriptor,
} from '../../read-data/visual-database';
import type { RecordWriter } from '../../do-work/record-writes';

// Roles a form never asks: the record's identity, its place in an order, and the name it is asked by.
const NOT_ASKED: readonly string[] = ['id', 'sort', 'title', 'nesting'];
// Value shapes a form asks as an open box to type in.
const TYPED: readonly string[] = ['text', 'longtext'];

export interface FormViewProps {
  records: readonly VisualDatabaseRecord[];
  lanes: readonly VisualDatabaseLaneDescriptor[];
  view: VisualDatabaseViewDescriptor;
  model: VisualDatabaseModel;
  writeRecord?: RecordWriter;
  /** The surface's own way to add a record, shown after the last one. */
  addOne?: React.ReactNode;
}

const empty = (value: unknown) => value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

/** The fields a form asks, in the list's own order. */
export function askedFields(model: VisualDatabaseModel): VisualDatabaseFieldDescriptor[] {
  return model.fields.filter((descriptor) => !NOT_ASKED.includes(descriptor.role) && descriptor.editable !== false);
}

/** Where a form opens: the first record still missing a value it asks, else the first record. */
export function firstWaiting(records: readonly VisualDatabaseRecord[], asked: readonly VisualDatabaseFieldDescriptor[]): number {
  const at = records.findIndex((record) => asked.some((descriptor) => empty(extractFieldValue(record, descriptor))));
  return at < 0 ? 0 : at;
}

function TypedField({ record, descriptor, writeRecord }: { record: VisualDatabaseRecord; descriptor: VisualDatabaseFieldDescriptor; writeRecord?: RecordWriter }) {
  const value = extractFieldValue(record, descriptor);
  const kept = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  const [draft, setDraft] = React.useState(kept);
  // The list's current value replaces what was typed whenever it changes underneath (another view, another device).
  React.useEffect(() => setDraft(kept), [kept]);
  const readOnly = !writeRecord || !canEditRecord(record);
  return (
    <Textarea
      label={descriptor.label}
      value={draft}
      rows={2}
      autoGrow
      maxHeight={280}
      readOnly={readOnly}
      placeholder={readOnly ? '' : 'Type here'}
      data-reach-role="form-field"
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        const next = draft.trim();
        if (readOnly || next === kept.trim()) return;
        writeField(writeRecord!, record, [{ descriptor, value: next.length > 0 ? next : null }]).catch(reportFailure(descriptor.label));
      }}
    />
  );
}

export function FormView({ records, lanes, view, model, writeRecord, addOne }: FormViewProps) {
  const asked = React.useMemo(() => askedFields(model), [model]);
  const [at, setAt] = React.useState(() => firstWaiting(records, asked));
  const total = records.length;
  const done = at >= total;
  const record = done ? null : records[at];
  const filled = records.filter((candidate) => asked.every((descriptor) => !empty(extractFieldValue(candidate, descriptor)))).length;

  if (total === 0 && !addOne) {
    return <EmptyPlaceholder icon={Check} message="Nothing to fill in here yet." />;
  }
  return (
    <Container layout="vertical" gap="lg" padding="md" data-reach-role="record-form" style={{ width: '100%', maxWidth: 560, marginInline: 'auto' }}>
      {total > 0 ? (
        <Container layout="vertical" gap="xs" padding="none">
          <ProgressBar percentage={total ? Math.round((Math.min(at, total) / total) * 100) : 0} color="var(--button-primary-bg)" height="0.25rem" />
          <Text variant="caption" color="muted" data-reach-role="form-progress">
            {done ? `${filled} of ${total} filled in` : `${at + 1} of ${total}`}
          </Text>
        </Container>
      ) : null}
      {record ? (
        <Container layout="vertical" gap="md" padding="none" data-reach-role="form-page" data-record-key={recordKeyOf(record)}>
          <Text variant="title" as="h2">{displayTitle(record)}</Text>
          {asked.map((descriptor) => (
            TYPED.includes(deriveShape(extractFieldValue(record, descriptor), descriptor)) ? (
              <TypedField key={`${recordKeyOf(record)}:${descriptor.id}`} record={record} descriptor={descriptor} writeRecord={writeRecord} />
            ) : (
              <Container key={descriptor.id} layout="vertical" gap="xs" padding="none" data-reach-role="form-field">
                <Text variant="label">{descriptor.label}</Text>
                <FieldControl descriptor={descriptor} record={record} model={model} view={view} lanes={lanes} grouping={null} writeRecord={writeRecord} />
              </Container>
            )
          ))}
        </Container>
      ) : (
        <Container layout="vertical" gap="sm" padding="none" data-reach-role="form-done">
          <Text variant="title" as="h2">{total ? 'All the way through' : 'Add the first one'}</Text>
          {total ? <Text variant="body" color="muted">Change any answer by going back, or add one of your own.</Text> : null}
          {addOne}
        </Container>
      )}
      <Container layout="horizontal" gap="sm" padding="none" justifyContent="between" alignItems="center">
        <Button variant="ghost" size="sm" disabled={at === 0} onClick={() => setAt((current) => Math.max(0, current - 1))} aria-label="Back">
          <Icon icon={ArrowLeft} size="xs" />
          Back
        </Button>
        {done ? null : (
          <Button variant="primary" size="sm" onClick={() => setAt((current) => Math.min(total, current + 1))} data-reach-action="form-next">
            {at + 1 === total ? 'Finish' : 'Next'}
            <Icon icon={ArrowRight} size="xs" />
          </Button>
        )}
      </Container>
    </Container>
  );
}

function recordKeyOf(record: VisualDatabaseRecord): string {
  return recordAddress(record) ?? record.id;
}
