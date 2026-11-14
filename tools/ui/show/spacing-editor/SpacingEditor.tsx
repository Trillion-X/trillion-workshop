// packages/ui/show/spacing-editor/SpacingEditor.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The blind numeric-style popover: a set of grouped numeric STEPPERS, used to
// edit a node's spacing (padding sides + the flow gap). It knows NOTHING about
// padding, gap, the scene, or the engine — it edits a list of {id,label,group,
// value} fields and emits (id → number). The field list is DATA passed in (the
// package's SPACING_FIELDS), so a new numeric style property (border radius,
// border width, …) is a data row, ZERO component code (L069 / L090). Reusable
// for any "edit these numbers" UI.
//
// A `group` of ≥2 fields (e.g. the 4 padding sides) gets a LINK toggle: while
// linked, changing any field sets the whole group to that value in ONE emit
// (onChangeGroup) — the Webflow / Framer "link all sides" affordance. Linking
// is always a deliberate choice: unrelated existing values are never coupled
// just because the editor opened. The consumer turns one emit into one atomic
// style write.
//
// Reference anatomy (21st.dev Number Field #28180, retrieved 2026-10-15): a
// labelled numeric control with keyboard support. Its stepper anatomy is
// inspiration only; this component keeps its existing Trillion controls and
// Screen Look tokens. Mobbin was unavailable for this review.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic / blind: no padding/gap/engine knowledge; the fields are data.
// 2. Values are clamped to each field's [min,max] before emit; step defaults 1.
// 3. Emits the raw (id, value); the consumer maps id → style path and writes.
//    The link toggle is presentation state owned here — never leaks outward.
//
// =============================================================================
// AI ASSISTANT DIRECTIVE
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client';

import * as React from 'react';

import { cn } from '../cn';
import { NamedIcon } from '../icon';

export type SpacingFieldView = {
  id: string;
  label: string;
  group: string;
  /** Current value (undefined → treated as 0, the engine's effective default). */
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number;
};

export type SpacingEditorProps = {
  /** The numeric fields to edit (data — already filtered to what applies). */
  fields: ReadonlyArray<SpacingFieldView>;
  /** Heading shown at the top of the popover. */
  title?: string;
  /** Optional context below the heading; product wording stays with the caller. */
  description?: string;
  /** Display words for stable caller-owned group identities. */
  groupLabels?: Readonly<Record<string, string>>;
  /** Set ONE field. */
  onChange: (id: string, value: number) => void;
  /** Set EVERY field in a group to the same value (the "link sides" affordance). */
  onChangeGroup?: (group: string, value: number) => void;
  onClose?: () => void;
  /** Positioning style applied to the root (the consumer anchors the popover). */
  style?: React.CSSProperties;
};

function clampField(field: SpacingFieldView, raw: number): number {
  let value = Number.isFinite(raw) ? raw : 0;
  if (typeof field.min === 'number') value = Math.max(field.min, value);
  if (typeof field.max === 'number') value = Math.min(field.max, value);
  return value;
}

// Group the flat field list, preserving first-seen order of groups AND fields.
function groupFields(fields: ReadonlyArray<SpacingFieldView>): Array<{ group: string; fields: SpacingFieldView[] }> {
  const order: string[] = [];
  const byGroup = new Map<string, SpacingFieldView[]>();
  for (const field of fields) {
    if (!byGroup.has(field.group)) {
      byGroup.set(field.group, []);
      order.push(field.group);
    }
    byGroup.get(field.group)!.push(field);
  }
  return order.map((group) => ({ group, fields: byGroup.get(group)! }));
}

export function SpacingEditor({ fields, title = 'Spacing', description, groupLabels, onChange, onChangeGroup, onClose, style }: SpacingEditorProps) {
  const titleId = React.useId();
  const descriptionId = React.useId();
  const panelRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { panelRef.current?.querySelector<HTMLInputElement>('input')?.focus(); }, []);
  const groups = React.useMemo(() => groupFields(fields), [fields]);
  // Link state per group is presentation state only. Start unlinked so opening
  // the editor cannot turn a one-side edit into an unexpected group write.
  const [linked, setLinked] = React.useState<Record<string, boolean>>({});

  function emit(field: SpacingFieldView, groupLinkable: boolean, raw: number) {
    const value = clampField(field, raw);
    if (groupLinkable && linked[field.group] && onChangeGroup) {
      onChangeGroup(field.group, value);
    } else {
      onChange(field.id, value);
    }
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-spacing-editor
      style={style}
      onKeyDown={event => {
        if (event.key !== 'Escape' || !onClose) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      className={cn(
        'flex w-[280px] max-w-[calc(100vw-16px)] flex-col gap-3 rounded-lg border p-3',
        'border-[var(--border-primary)] bg-[var(--surface-primary)] shadow-md',
      )}
    >
      <div className="flex items-center justify-between">
        <span id={titleId} className="text-[length:var(--font-size-caption)] font-medium text-[var(--text-secondary,var(--text-primary))]">{title}</span>
        {onClose ? (
          <button type="button" data-spacing-close aria-label="Close" onClick={onClose} className="text-[var(--text-secondary,var(--text-primary))] hover:text-[var(--text-primary)]">
            ×
          </button>
        ) : null}
      </div>
      {description ? <p id={descriptionId} className="m-0 text-[length:var(--font-size-caption)] text-[var(--text-secondary,var(--text-primary))]">{description}</p> : null}

      {groups.map(({ group, fields: groupFieldList }) => {
        const linkable = Boolean(onChangeGroup) && groupFieldList.length >= 2;
        const isLinked = linkable && !!linked[group];
        return (
          <div key={group} role="group" aria-label={groupLabels?.[group] ?? group} data-spacing-group={group} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[length:var(--font-size-caption)] text-[var(--text-secondary,var(--text-primary))]">{groupLabels?.[group] ?? group}</span>
              {linkable ? (
                <button
                  type="button"
                  data-spacing-link={isLinked ? 'on' : 'off'}
                  aria-label={`${isLinked ? 'Unlink' : 'Link'} ${groupLabels?.[group] ?? group}`}
                  aria-pressed={isLinked}
                  onClick={() => setLinked((prev) => ({ ...prev, [group]: !prev[group] }))}
                  className={cn(
                    'flex items-center gap-1 rounded px-1.5 py-0.5 text-[length:var(--font-size-caption)]',
                    isLinked ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary,var(--text-primary))] hover:text-[var(--text-primary)]',
                  )}
                >
                  <NamedIcon name={isLinked ? 'Link2' : 'Unlink2'} fallback="Link2" size="xs" />
                  {isLinked ? 'Linked' : 'Link'}
                </button>
              ) : null}
            </div>
            <div className={cn('grid gap-1.5', groupFieldList.length >= 3 ? 'grid-cols-2' : 'grid-cols-1')}>
              {groupFieldList.map((field) => (
                <SpacingStepper key={field.id} field={field} onCommit={(value) => emit(field, linkable, value)} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// One numeric field: [label] [−] [value] [+]. The − / + buttons step by
// field.step (default 1); the input accepts a typed number. Pure presentation —
// every change clamps in the parent's `emit` before it leaves the editor. The
// consumer maps id → style path and writes. Keep
// the draft local while focused: an empty or partial edit is not a request to
// write zero, and a parent render must not interrupt a multi-digit edit.
function SpacingStepper({ field, onCommit }: { field: SpacingFieldView; onCommit: (value: number) => void }) {
  const current = typeof field.value === 'number' ? field.value : 0;
  const step = typeof field.step === 'number' && field.step > 0 ? field.step : 1;
  const [draft, setDraft] = React.useState(String(current));
  const [focused, setFocused] = React.useState(false);
  React.useEffect(() => {
    if (!focused) setDraft(String(current));
  }, [current, focused]);
  const restoreDraft = () => {
    setFocused(false);
    const parsed = draft.trim() === '' ? NaN : Number(draft);
    if (Number.isFinite(parsed)) {
      const clamped = clampField(field, parsed);
      setDraft(String(clamped));
    } else {
      setDraft(String(current));
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-[var(--border-primary)] bg-[var(--surface-secondary,transparent)] px-2 py-1.5 focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]">
      <span className="text-[12px] text-[var(--text-secondary,var(--text-primary))]">{field.label}</span>
      <div className="flex w-full items-center justify-between gap-1">
        <button
          type="button"
          data-spacing-dec={field.id}
          aria-label={`Decrease ${field.label}`}
          onClick={() => onCommit(current - step)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--text-secondary,var(--text-primary))] hover:bg-[var(--glass-bg-hover,rgba(255,255,255,0.06))] hover:text-[var(--text-primary)]"
        >
          <NamedIcon name="Minus" fallback="Minus" size="xs" />
        </button>
        <input
          data-spacing-input={field.id}
          aria-label={field.label}
          type="number"
          value={focused ? draft : current}
          min={field.min}
          max={field.max}
          step={step}
          onFocus={() => setFocused(true)}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setDraft(value);
            if (value.trim() === '') return;
            const parsed = event.currentTarget.valueAsNumber;
            if (Number.isFinite(parsed)) onCommit(clampField(field, parsed));
          }}
          onBlur={restoreDraft}
          className="min-w-0 flex-1 bg-transparent text-center text-[12.5px] text-[var(--text-primary)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        <button
          type="button"
          data-spacing-inc={field.id}
          aria-label={`Increase ${field.label}`}
          onClick={() => onCommit(current + step)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--text-secondary,var(--text-primary))] hover:bg-[var(--glass-bg-hover,rgba(255,255,255,0.06))] hover:text-[var(--text-primary)]"
        >
          <NamedIcon name="Plus" fallback="Plus" size="xs" />
        </button>
      </div>
    </div>
  );
}
