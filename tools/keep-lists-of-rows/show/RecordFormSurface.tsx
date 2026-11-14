//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The visual-database FORM: a vertical column of fields (label + the SAME shape
// editor the board rows/cards/table use) over a VisualDatabaseModel, with a single
// data-defined submit. It is the form counterpart of VisualDatabaseSurface — one
// generic primitive, configured by descriptor DATA, for EVERY "fill this in and
// submit" surface (an order ticket, a new-connection form, a new-booking form,
// an issue composer, …). Buy/Sell, Yes/No, BuyToOpen/SellToClose, a venue list —
// ALL emerge from each field descriptor's `domain` (DATA); this file contains
// ZERO domain vocabulary.
//
// TWO modes, ONE path (draft → assemble → submit):
//   - COMPOSE (no `record`): a synthetic empty record hosts the draft; submit
//     assembles the payload from descriptor write-paths (applyFieldWrites) and
//     creates a record via `writeRecord` (or invokes the submit action) — exactly
//     RecordComposer's create path (VisualDatabaseSurface.tsx:1108-1139).
//   - EDIT (`record` present): the draft seeds from that record; submit writes
//     back to the same address.
//
// Each field renders through `editorForShape` against a synthetic record that
// reflects the CURRENT draft, so choice editors show the selected option and
// `effectiveDomain` resolves options from the descriptor's inline domain. The
// draft is owner-overridable (controlled) or self-held (uncontrolled).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Fields, options, visibility, submit copy + target are ALL descriptor/action
//    DATA. No field ids, no enum literals, no per-instrument branching here.
// 2. The payload is assembled ONLY through `applyFieldWrites` (descriptor write
//    paths) — never by hand-built object keys.
// 3. Submit prefers a data-defined VisualDatabaseActionDescriptor (onInvokeAction);
//    falls back to a generic writeRecord create. Required fields gate submit.
// 4. Zero raw HTML / className — composed from ui + visual-database editors only.
// =============================================================================

import React from 'react';
import { Button, Container, Text } from '@/packages/ui';
import { applyFieldWrites, buildRecordWrite, type AddressedWrite, type FieldWrite, type RecordWriter } from '@/packages/visual-database/do-work/record-writes';
import {
  editorForShape,
  reportFailure,
  reportSuccess,
} from '@/packages/visual-database/show/field-editors';
import {
  effectiveDomain,
  extractFieldValue,
  type VisualDatabaseActionDescriptor,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseModel,
  type VisualDatabaseRecord,
} from '@/packages/visual-database/read-data/visual-database';

// ---------------------------------------------------------------------------
// Form-field selection + the synthetic draft record
// ---------------------------------------------------------------------------

/** Purely-structural bindings a form never asks the human to fill: machine
 *  identity and the sort key. Everything else is a form field (the title/body
 *  zones included — a form needs them). An exclude-list, not an allow-list. */
const NON_FORM_ROLES: ReadonlySet<string> = new Set(['id', 'sort']);

/** The fields a person fills, in descriptor order: editable, non-structural. */
function formFieldDescriptors(model: VisualDatabaseModel): readonly VisualDatabaseFieldDescriptor[] {
  return model.fields.filter((field) => field.editable !== false && !NON_FORM_ROLES.has(field.role));
}

/** Project the current draft `values` (keyed by descriptor id) into a synthetic
 *  record so the shape editors render the selected value and `effectiveDomain`
 *  resolves options. The draft lives at the payload root under each id; the
 *  descriptors' default `paths` include `['payload', id]`, so reads line up. */
function draftRecord(base: VisualDatabaseRecord | undefined, values: Readonly<Record<string, unknown>>): VisualDatabaseRecord {
  const baseRaw = base && base.raw && typeof base.raw === 'object' && !Array.isArray(base.raw)
    ? (base.raw as Record<string, unknown>)
    : {};
  const basePayload = baseRaw.payload && typeof baseRaw.payload === 'object' && !Array.isArray(baseRaw.payload)
    ? (baseRaw.payload as Record<string, unknown>)
    : {};
  return {
    id: base?.id ?? 'record-form-draft',
    title: base?.title ?? 'record-form-draft',
    body: base?.body ?? '',
    kind: base?.kind ?? 'record-form',
    group: base?.group ?? 'record-form',
    lane: base?.lane ?? { id: 'unassigned', label: 'Unassigned', order: 100000, tone: 'neutral' },
    date: base?.date ?? null,
    sort: base?.sort ?? null,
    badges: base?.badges ?? [],
    links: base?.links ?? [],
    raw: { ...baseRaw, payload: { ...basePayload, ...values } },
  };
}

/** Seed the draft from an existing record's current field values (edit mode); an
 *  empty draft for compose. */
function seedValues(record: VisualDatabaseRecord | undefined, fields: readonly VisualDatabaseFieldDescriptor[]): Record<string, unknown> {
  if (!record) return {};
  const seed: Record<string, unknown> = {};
  for (const field of fields) {
    const value = extractFieldValue(record, field);
    if (value !== null && value !== undefined) seed[field.id] = value;
  }
  return seed;
}

function isFieldVisible(descriptor: VisualDatabaseFieldDescriptor, values: Readonly<Record<string, unknown>>): boolean {
  const gate = descriptor.visibleWhen;
  if (!gate) return true;
  const current = values[gate.field];
  const text = current === null || current === undefined ? '' : String(current);
  return gate.equals.includes(text);
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'record';
}

// ---------------------------------------------------------------------------
// One field row
// ---------------------------------------------------------------------------

function FormFieldRow({ descriptor, model, record, value, onChange }: {
  descriptor: VisualDatabaseFieldDescriptor;
  model: VisualDatabaseModel;
  record: VisualDatabaseRecord;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const shape = descriptor.shape ?? 'text';
  const Editor = editorForShape(shape);
  const domain = React.useMemo(
    () => (shape === 'choice' || shape === 'multi' ? effectiveDomain(descriptor, model) : []),
    [descriptor, model, shape],
  );
  return (
    <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" padding="sm" border="bottom">
      <Text variant="body-xs" color="faint">{descriptor.label}</Text>
      <Editor
        record={record}
        descriptor={descriptor}
        value={value}
        domain={domain}
        commit={onChange}
        readOnly={false}
        model={model}
      />
    </Container>
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

export interface RecordFormSurfaceProps {
  /** The model whose field descriptors define the form (options + visibility). */
  model: VisualDatabaseModel;
  /** Existing record to EDIT. Absent = COMPOSE a new record. */
  record?: VisualDatabaseRecord;
  /** Controlled draft (keyed by descriptor id). Omit for self-held draft. */
  values?: Readonly<Record<string, unknown>>;
  /** Receives the next draft on any field change (required when `values` is set). */
  onChange?: (next: Readonly<Record<string, unknown>>) => void;
  /** Data-defined submit. When set, submit invokes this action with the assembled
   *  draft record; otherwise submit creates/updates via `writeRecord`. */
  submitAction?: VisualDatabaseActionDescriptor;
  /** Invokes the submit action (the surface wires this to the engine). */
  onInvokeAction?: (action: VisualDatabaseActionDescriptor, context: { record: VisualDatabaseRecord }) => void | Promise<unknown>;
  /** Generic durable writer — the create/update fallback when no submit action. */
  writeRecord?: RecordWriter;
  /** Submit button label. Default 'Submit'. */
  submitLabel?: string;
  /** Called after a successful submit (e.g. to reset a parent or close). */
  onSubmitted?: () => void;
}

/**
 * Render a descriptor-driven form over a VisualDatabaseModel.
 *
 * @example
 * ```tsx
 * <RecordFormSurface model={ticketModel} writeRecord={writeRecord} submitLabel="Place order" />
 * ```
 */
export function RecordFormSurface({
  model,
  record,
  values: controlledValues,
  onChange,
  submitAction,
  onInvokeAction,
  writeRecord,
  submitLabel = 'Submit',
  onSubmitted,
}: RecordFormSurfaceProps) {
  const fields = React.useMemo(() => formFieldDescriptors(model), [model]);
  const [selfValues, setSelfValues] = React.useState<Record<string, unknown>>(() => seedValues(record, fields));
  const values = controlledValues ?? selfValues;
  const setValues = React.useCallback((next: Readonly<Record<string, unknown>>) => {
    if (onChange) onChange(next);
    else setSelfValues(next);
  }, [onChange]);
  const setValue = React.useCallback((id: string, next: unknown) => {
    setValues({ ...values, [id]: next });
  }, [values, setValues]);

  const [busy, setBusy] = React.useState(false);
  const visibleFields = fields.filter((field) => isFieldVisible(field, values));
  const draft = draftRecord(record, values);
  const requiredOk = visibleFields.every((field) => field.editable === false || hasValue(values[field.id]) || field.role === 'body');
  const canSubmit = Boolean((submitAction && onInvokeAction) || writeRecord);

  function assemblePayload(): Record<string, unknown> {
    const writes: FieldWrite[] = [];
    for (const field of visibleFields) {
      const value = values[field.id];
      if (value !== null && value !== undefined) writes.push({ descriptor: field, value });
    }
    const payload: Record<string, unknown> = {};
    applyFieldWrites(payload, writes);
    return payload;
  }

  function submit() {
    if (busy || !canSubmit) return;
    setBusy(true);
    const payload = assemblePayload();
    const done = (promise: Promise<unknown>) => {
      promise
        .then(() => { if (!record) setSelfValues({}); reportSuccess('Submitted'); onSubmitted?.(); })
        .catch(reportFailure('submit'))
        .finally(() => setBusy(false));
    };
    // Data-defined submit action wins (the order/booking/connect action lives in data).
    if (submitAction && onInvokeAction) {
      const submittedRecord = draftRecord(record, values);
      done(Promise.resolve(onInvokeAction(submitAction, { record: submittedRecord })));
      return;
    }
    // Generic create/update fallback.
    if (!writeRecord) { setBusy(false); return; }
    if (record) {
      const writes: FieldWrite[] = visibleFields
        .filter((field) => values[field.id] !== null && values[field.id] !== undefined)
        .map((field) => ({ descriptor: field, value: values[field.id] }));
      const entry: AddressedWrite | null = buildRecordWrite(record, writes);
      done(entry ? writeRecord(entry) : Promise.resolve());
      return;
    }
    const titleField = visibleFields.find((field) => field.role === 'title');
    const titleText = titleField ? String(values[titleField.id] ?? '') : '';
    const stamp = Date.now().toString(36);
    const addressLabel = [draft.kind, slugify(titleText).slice(0, 40), stamp].filter(Boolean).join('::');
    done(writeRecord({ addressLabel, payload }));
  }

  if (fields.length === 0) {
    return (
      <Container layout="vertical" gap="sm" padding="none">
        <Text variant="body-xs" color="faint">No fields to fill.</Text>
      </Container>
    );
  }

  return (
    <Container layout="vertical" gap="lg" padding="none">
      <Container layout="vertical" gap="none" padding="none">
        {visibleFields.map((field) => (
          <FormFieldRow
            key={field.id}
            descriptor={field}
            model={model}
            record={draft}
            value={values[field.id] ?? null}
            onChange={(next) => setValue(field.id, next)}
          />
        ))}
      </Container>
      <Button variant="primary" size="lg" disabled={busy || !requiredOk || !canSubmit} onClick={submit}>
        {submitLabel}
      </Button>
    </Container>
  );
}
