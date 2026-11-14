//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The GENERIC compose field-set — the missing visual-database piece for surfaces
// that COMPOSE a new record from a self-describing capability descriptor (an
// order ticket, a "new connection" form, a "new booking" form, …). VisualDatabase
// renders EXISTING records; this renders a DRAFT keyed by field id and hands the
// draft back. It reuses the SAME shape→editor registry (`editorForShape`) that
// powers in-place record editing, so a compose control and an edit control are
// the same control. Zero per-domain components, zero domain vocabulary here.
//
// `control` (= visual-database `shape`: choice/text/number/flag/…) selects the
// editor; `domain.values` supply a choice's OPTIONS (DATA). So Buy/Sell today,
// Yes/No for a prediction market, BuyToOpen/SellToClose for options ALL emerge
// from the descriptor DATA with ZERO change here — the same genericity the rest
// of visual-database has, extended to composing.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. PURE-ish + CONTROLLED: holds only the in-progress draft (values keyed by
//    field id); the owner receives every change via onChange and owns submit.
// 2. ZERO DOMAIN VOCABULARY: every label/option/visibility comes from the
//    descriptor DATA. No product literal here.
// 3. ONE RENDERER PER SHAPE: dispatches through `editorForShape` (visual-database's
//    registry) — never a per-field component, never a parallel control set.
// 4. visibleWhen is evaluated generically against the draft (a field appears only
//    when another field's value matches — DATA-defined).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Container, Text } from '@/packages/ui';
import { editorForShape } from '@/packages/visual-database/show/field-editors';
import {
  effectiveDomain,
  syntheticFieldDescriptor,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseFieldDomainValue,
  type VisualDatabaseModel,
  type VisualDatabaseRecord,
} from '@/packages/visual-database/read-data/visual-database';

/** Gate a compose field on another field's value (DATA-defined visibility). */
export interface ComposeVisibleWhen {
  readonly field: string;
  readonly equals: readonly string[];
}

/** One compose field descriptor: a visual-database field shape + compose extras. */
export interface ComposeFieldDescriptor {
  readonly id: string;
  readonly label: string;
  /** visual-database value shape — selects the editor (choice/text/number/flag/…). */
  readonly shape: string;
  readonly required?: boolean;
  /** Choice OPTIONS as DATA (the visual-database domain). */
  readonly domain?: { readonly values?: readonly VisualDatabaseFieldDomainValue[]; readonly open?: boolean };
  readonly placeholder?: string;
  readonly hint?: string;
  readonly visibleWhen?: ComposeVisibleWhen;
}

export interface ComposeFieldSetProps {
  /** The capability's compose fields (DATA). */
  readonly fields: readonly ComposeFieldDescriptor[];
  /** Current draft values, keyed by field id (owner-held). */
  readonly values: Readonly<Record<string, unknown>>;
  /** Receives the next draft on any field change. */
  readonly onChange: (next: Readonly<Record<string, unknown>>) => void;
}

/** A synthetic empty record so the shape editors (which read from a record for
 *  some affordances) have a valid, value-less host. The draft value is passed
 *  explicitly; the record is only a structural placeholder. */
const DRAFT_RECORD: VisualDatabaseRecord = {
  id: 'compose-draft',
  title: 'compose-draft',
  body: '',
  kind: 'compose',
  group: 'compose',
  lane: { id: 'unassigned', label: 'Unassigned', order: 100000, tone: 'neutral' },
  date: null,
  sort: null,
  badges: [],
  links: [],
  raw: { id: 'compose-draft', payload: {} },
};

/** A minimal model so `effectiveDomain` can resolve a field's option set from
 *  the descriptor's inline domain values (no feed records needed for compose). */
function composeModel(descriptor: VisualDatabaseFieldDescriptor): VisualDatabaseModel {
  return { records: [], fields: [descriptor], views: [], actions: [], palette: [], gridProperties: [] };
}

function isVisible(gate: ComposeVisibleWhen | undefined, values: Readonly<Record<string, unknown>>): boolean {
  if (!gate) return true;
  const current = values[gate.field];
  const text = current === null || current === undefined ? '' : String(current);
  return gate.equals.includes(text);
}

/** Build a visual-database field descriptor from a compose field descriptor, so the
 *  shared editors + domain resolution apply unchanged. */
function toFieldDescriptor(field: ComposeFieldDescriptor): VisualDatabaseFieldDescriptor {
  return {
    ...syntheticFieldDescriptor(field.id),
    label: field.label,
    role: field.shape === 'choice' ? 'badge' : 'none',
    shape: field.shape,
    domain: field.domain && (field.domain.values?.length || field.domain.open)
      ? { values: field.domain.values, open: field.domain.open }
      : undefined,
  };
}

/** One compose field row: a tiny label + the shape's editor (the SAME editor
 *  used to edit that shape on an existing record). */
function ComposeField({ field, value, onCommit }: {
  field: ComposeFieldDescriptor;
  value: unknown;
  onCommit: (next: unknown) => void;
}) {
  const descriptor = React.useMemo(() => toFieldDescriptor(field), [field]);
  const Editor = editorForShape(field.shape);
  const domain = React.useMemo(
    () => effectiveDomain(descriptor, composeModel(descriptor)),
    [descriptor],
  );
  return (
    <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" padding="sm" border="bottom">
      <Text variant="body-xs" color="faint">{field.label}</Text>
      <Editor
        record={DRAFT_RECORD}
        descriptor={descriptor}
        value={value}
        domain={domain}
        commit={onCommit}
        readOnly={false}
      />
    </Container>
  );
}

/**
 * Render a capability's compose field-set. Each field renders through the
 * visual-database shape editor registry; the draft is owner-held and flows back via
 * onChange. visibleWhen hides fields generically.
 *
 * @example
 * ```tsx
 * <ComposeFieldSet fields={capability.fields} values={draft} onChange={setDraft} />
 * ```
 */
export function ComposeFieldSet({ fields, values, onChange }: ComposeFieldSetProps) {
  const setValue = React.useCallback((id: string, next: unknown) => {
    onChange({ ...values, [id]: next });
  }, [values, onChange]);

  return (
    <Container layout="vertical" gap="none" padding="none">
      {fields
        .filter((field) => isVisible(field.visibleWhen, values))
        .map((field) => (
          <ComposeField
            key={field.id}
            field={field}
            value={values[field.id] ?? null}
            onCommit={(next) => setValue(field.id, next)}
          />
        ))}
    </Container>
  );
}
