// packages/workflow-canvas/show/StepFieldRenderer.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The BLIND renderer for a workflow step's editor. Consumes the self-describing
// StepFieldDescriptor[] produced by read-data's describeStepFields and paints a
// Lindy-style field stack. It switches ONLY on control.kind — a closed set of
// generic UI primitives (text/number/datetime/duration/select/structured/union)
// — and holds ZERO step-kind vocabulary. It never names 'action'/'ask'/'wait';
// adding a step kind changes the read-data schema table, not this file.
//
// Reference anatomy (workflow-canvas screen contract): every Lindy node config
// is the same uniform field stack — label + helper + control, top to bottom.
// This component IS that stack, driven by data.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No step-kind branching. The only switch is over the closed control-kind
//    primitive set. (L090 / enum dissolution.)
// 2. Reads/writes are path-addressed (machine-readable): every binding is an
//    explicit string[] into config (or the whole step for base 'step').
// 3. Behavior-faithful to the prior hand-written StepEditor — same controls,
//    labels, prefill, inject, and union branch defaults (L030/L101).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Button, Container, Dropdown, Input, StructuredValueEditor, Text } from '../../ui';
import { InjectDataPicker } from './InjectDataPicker';
import { WaitDurationEditor, formatDuration } from './WaitDurationEditor';
import type {
  ResolvedControl,
  StepFieldDescriptor,
  StepFieldOption,
  StepFieldTemplate,
} from '../read-data/describe-step-fields';

/** A working-example for an injectable structured field, resolved by the caller
 *  (which owns the cross-field capability surface) — the renderer stays blind. */
export interface StepFieldExample {
  payload: Record<string, unknown>;
  keys: readonly string[];
}

export interface StepFieldRendererProps {
  /** The whole step record (kind + config). */
  step: unknown;
  /** Self-describing fields from read-data's describeStepFields. */
  descriptors: readonly StepFieldDescriptor[];
  onChange: (step: unknown) => void;
  /** Prior steps in this action — inject sources for structured fields. */
  priorSteps?: readonly { stepId: string; sentence: string }[];
  /** Trigger input fields — inject sources for structured fields. */
  inputFields?: readonly { key: string; label: string }[];
  /** Translation hook for StructuredValueEditor (binding ASTs → sentences). */
  renderValue?: (value: unknown, label: string | null) => React.ReactNode | null;
  /** For an injectable structured field: the working example for the step's
   *  current sibling selection (e.g. the ask target). Caller owns the lookup. */
  exampleFor?: (step: unknown) => StepFieldExample | null;
  /** Read-only mode: render the same descriptors as labeled value rows (the
   *  shipped/non-editable detail view). Same field stack, no controls — one
   *  blind renderer, two modes (L069). */
  readOnly?: boolean;
  /** Humanize a raw id for read-only display when no option label exists
   *  (e.g. 'action:reply' → 'Reply'). Caller owns the vocabulary; default
   *  passes the value through. */
  formatId?: (value: string) => string;
}

// ---------------------------------------------------------------------------
// Path helpers — immutable, generic (machine-readable bindings)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getAtPath(base: unknown, path: readonly string[]): unknown {
  let cursor: unknown = base;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function setAtPath(base: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const obj = isRecord(base) ? base : {};
  return { ...obj, [head]: setAtPath(obj[head], rest, value) };
}

function configOf(step: unknown): Record<string, unknown> {
  return isRecord(step) && isRecord(step.config) ? step.config : {};
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Build the object a union branch switches to, seeding each branch field's
 *  default — so the renderer reconstructs the shape (e.g. { type, secs: 60 })
 *  from data without knowing the step kind. */
function branchSeed(discriminantKey: string, branch: string, templates: readonly StepFieldTemplate[]): Record<string, unknown> {
  let seed: Record<string, unknown> = { [discriminantKey]: branch };
  for (const tpl of templates) {
    if (tpl.default !== undefined) seed = setAtPath(seed, tpl.path, tpl.default) as Record<string, unknown>;
  }
  return seed;
}

// ---------------------------------------------------------------------------
// One field row — switches only on control.kind
// ---------------------------------------------------------------------------

function FieldRow({
  step,
  descriptor,
  fullPath,
  onChange,
  priorSteps = [],
  inputFields = [],
  renderValue,
  exampleFor,
}: {
  step: unknown;
  descriptor: StepFieldDescriptor;
  fullPath: string[];
  onChange: (step: unknown) => void;
  priorSteps?: readonly { stepId: string; sentence: string }[];
  inputFields?: readonly { key: string; label: string }[];
  renderValue?: (value: unknown, label: string | null) => React.ReactNode | null;
  exampleFor?: (step: unknown) => StepFieldExample | null;
}): React.ReactElement {
  const control = descriptor.control;
  const config = configOf(step);
  const currentValue = descriptor.base === 'step' ? step : getAtPath(config, fullPath);

  // Write a value to this field's address (config path, or the whole step).
  const writeValue = (value: unknown): void => {
    if (descriptor.base === 'step') { onChange(value); return; }
    onChange({ ...(isRecord(step) ? step : {}), config: setAtPath(config, fullPath, value) });
  };
  // Write multiple sibling config paths at once (select prefill).
  const writeConfigPaths = (patches: { path: string[]; value: unknown }[]): void => {
    let next: unknown = config;
    for (const patch of patches) next = setAtPath(next, patch.path, patch.value);
    onChange({ ...(isRecord(step) ? step : {}), config: next });
  };

  switch (control.kind) {
    case 'text':
      return (
        <Input
          label={descriptor.label ?? undefined}
          placeholder={control.placeholder}
          value={readString(currentValue, control.fallback ?? '')}
          onChange={(event) => writeValue(event.target.value)}
        />
      );
    case 'number':
      return (
        <Input
          label={descriptor.label ?? undefined}
          value={readString(typeof currentValue === 'number' ? String(currentValue) : currentValue)}
          onChange={(event) => {
            const next = Number(event.target.value);
            writeValue(Number.isFinite(next) ? next : 0);
          }}
        />
      );
    case 'datetime':
      return (
        <Input
          label={descriptor.label ?? undefined}
          type="datetime-local"
          value={readString(currentValue)}
          onChange={(event) => writeValue(event.target.value)}
        />
      );
    case 'duration':
      return (
        <WaitDurationEditor
          secs={typeof currentValue === 'number' ? currentValue : 60}
          onChange={(secs) => writeValue(secs)}
        />
      );
    case 'select':
      return renderSelect(control, descriptor, readString(currentValue), config, writeConfigPaths);
    case 'structured':
      return renderStructured(control, descriptor, currentValue, step, writeValue, { priorSteps, inputFields, renderValue, exampleFor });
    case 'union':
      return renderUnion(control, descriptor, fullPath, step, onChange, { priorSteps, inputFields, renderValue, exampleFor });
  }
}

function renderSelect(
  control: Extract<ResolvedControl, { kind: 'select' }>,
  descriptor: StepFieldDescriptor,
  value: string,
  config: Record<string, unknown>,
  writeConfigPaths: (patches: { path: string[]; value: unknown }[]) => void,
): React.ReactElement {
  // Keep a current-but-unlisted value visible (a saved option no longer in the
  // live list) so the field never silently blanks.
  const items: StepFieldOption[] = value && !control.options.some((o) => o.value === value)
    ? [{ value, label: value }, ...control.options]
    : [...control.options];
  const empty = items.length === 0;
  return (
    <Dropdown
      label={descriptor.label ?? undefined}
      items={items}
      value={value}
      placeholder={empty ? control.emptyHint : control.placeholder}
      disabled={empty}
      scrollable
      onValueChange={(next) => {
        const patches: { path: string[]; value: unknown }[] = [{ path: descriptor.path, value: next }];
        // Declarative prefill: chosen option's examplePayload seeds an empty
        // sibling (Lindy's filled-by-default field anatomy).
        const prefill = control.prefillSibling;
        if (prefill) {
          const option = items.find((o) => o.value === next);
          const siblingValue = getAtPath(config, prefill.path);
          const siblingEmpty = !isRecord(siblingValue) || Object.keys(siblingValue).length === 0;
          if (option?.examplePayload && siblingEmpty) {
            patches.push({ path: prefill.path, value: option.examplePayload });
          }
        }
        writeConfigPaths(patches);
      }}
    />
  );
}

function renderStructured(
  control: Extract<ResolvedControl, { kind: 'structured' }>,
  descriptor: StepFieldDescriptor,
  currentValue: unknown,
  step: unknown,
  writeValue: (value: unknown) => void,
  ctx: {
    priorSteps?: readonly { stepId: string; sentence: string }[];
    inputFields?: readonly { key: string; label: string }[];
    renderValue?: (value: unknown, label: string | null) => React.ReactNode | null;
    exampleFor?: (step: unknown) => StepFieldExample | null;
  },
): React.ReactElement {
  const value = currentValue ?? (control.injectable ? {} : currentValue);
  const valueIsEmpty = !isRecord(value) || Object.keys(value).length === 0;
  const example = control.injectable ? ctx.exampleFor?.(step) ?? null : null;
  return (
    <Container layout="vertical" gap="xs">
      {descriptor.label && (
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
          <Text variant="caption" color="muted">{descriptor.label}</Text>
          {example && !valueIsEmpty && (
            <Button variant="ghost" size="sm" onClick={() => writeValue(example.payload)}>
              Use a working example
            </Button>
          )}
        </Container>
      )}
      {example && example.keys.length > 0 && (
        <Text variant="caption" color="muted">
          Usually includes: {example.keys.slice(0, 5).map((key) => key.replace(/[_-]+/g, ' ')).join(', ')}
        </Text>
      )}
      <StructuredValueEditor
        value={value ?? {}}
        onChange={(next: unknown) => writeValue(next)}
        renderValue={ctx.renderValue}
        maxDepth={6}
      />
      {control.injectable && (
        <InjectDataPicker
          priorSteps={ctx.priorSteps ?? []}
          inputFields={ctx.inputFields}
          onInject={(fieldName, binding) => writeValue({
            ...(isRecord(value) ? value : {}),
            [fieldName]: binding,
          })}
        />
      )}
    </Container>
  );
}

function renderUnion(
  control: Extract<ResolvedControl, { kind: 'union' }>,
  descriptor: StepFieldDescriptor,
  unionPath: string[],
  step: unknown,
  onChange: (step: unknown) => void,
  ctx: {
    priorSteps?: readonly { stepId: string; sentence: string }[];
    inputFields?: readonly { key: string; label: string }[];
    renderValue?: (value: unknown, label: string | null) => React.ReactNode | null;
    exampleFor?: (step: unknown) => StepFieldExample | null;
  },
): React.ReactElement {
  const config = configOf(step);
  return (
    <Container layout="vertical" gap="sm">
      <Dropdown
        label={descriptor.label ?? undefined}
        items={[...control.options]}
        value={control.activeBranch}
        onValueChange={(branch) => {
          const templates = control.branchTemplates[branch] ?? [];
          const seed = branchSeed(control.discriminantKey, branch, templates);
          onChange({ ...(isRecord(step) ? step : {}), config: setAtPath(config, unionPath, seed) });
        }}
      />
      {control.branchFields.map((branchField, index) => (
        <FieldRow
          key={`${control.activeBranch}:${index}`}
          step={step}
          descriptor={branchField}
          fullPath={[...unionPath, ...branchField.path]}
          onChange={onChange}
          priorSteps={ctx.priorSteps}
          inputFields={ctx.inputFields}
          renderValue={ctx.renderValue}
          exampleFor={ctx.exampleFor}
        />
      ))}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Read-only mode — the SAME descriptors as labeled value rows (the shipped /
// non-editable detail view). Same closed control-kind switch, no controls.
// ---------------------------------------------------------------------------

function ReadValue({ label, children }: { label: string | null; children: React.ReactNode }): React.ReactElement {
  return (
    <Container layout="vertical" gap="xs">
      {label && <Text variant="caption" color="muted">{label}</Text>}
      {children}
    </Container>
  );
}

function ReadOnlyFieldRow({
  step,
  descriptor,
  fullPath,
  renderValue,
  formatId = (value) => value,
}: {
  step: unknown;
  descriptor: StepFieldDescriptor;
  fullPath: string[];
  renderValue?: (value: unknown, label: string | null) => React.ReactNode | null;
  formatId?: (value: string) => string;
}): React.ReactElement {
  const control = descriptor.control;
  const config = configOf(step);
  const value = descriptor.base === 'step' ? step : getAtPath(config, fullPath);
  const DASH = '—';

  switch (control.kind) {
    case 'text':
    case 'number':
    case 'datetime': {
      const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
      return <ReadValue label={descriptor.label}><Text variant="caption">{text || DASH}</Text></ReadValue>;
    }
    case 'duration':
      return (
        <ReadValue label={descriptor.label}>
          <Text variant="caption">{formatDuration(typeof value === 'number' ? value : 0)}</Text>
        </ReadValue>
      );
    case 'select': {
      const raw = readString(value);
      const option = control.options.find((o) => o.value === raw);
      const label = option ? option.label : raw ? formatId(raw) : '';
      return <ReadValue label={descriptor.label}><Text variant="caption">{label || DASH}</Text></ReadValue>;
    }
    case 'structured':
      return (
        <ReadValue label={descriptor.label}>
          <StructuredValueEditor value={value ?? {}} readOnly renderValue={renderValue} maxDepth={6} />
        </ReadValue>
      );
    case 'union': {
      const activeOption = control.options.find((o) => o.value === control.activeBranch);
      return (
        <Container layout="vertical" gap="xs">
          <ReadValue label={descriptor.label}>
            <Text variant="caption">{activeOption?.label ?? control.activeBranch}</Text>
          </ReadValue>
          {control.branchFields.map((branchField, index) => (
            <ReadOnlyFieldRow
              key={`${control.activeBranch}:${index}`}
              step={step}
              descriptor={branchField}
              fullPath={[...fullPath, ...branchField.path]}
              renderValue={renderValue}
              formatId={formatId}
            />
          ))}
        </Container>
      );
    }
  }
}

/**
 * The blind step renderer: a field stack rendered entirely from data. No
 * step-kind branch anywhere — only the closed control-kind primitive switch.
 * `readOnly` swaps interactive controls for labeled value rows (shipped detail
 * view) — one primitive, two modes (L069).
 */
export function StepFieldRenderer({
  step,
  descriptors,
  onChange,
  priorSteps,
  inputFields,
  renderValue,
  exampleFor,
  readOnly = false,
  formatId,
}: StepFieldRendererProps): React.ReactElement {
  return (
    <Container layout="vertical" gap="sm" data-workflow-step-fields="true">
      {descriptors.map((descriptor, index) => {
        const key = `${descriptor.path.join('.') || 'step'}:${index}`;
        return readOnly ? (
          <ReadOnlyFieldRow
            key={key}
            step={step}
            descriptor={descriptor}
            fullPath={descriptor.path}
            renderValue={renderValue}
            formatId={formatId}
          />
        ) : (
          <FieldRow
            key={key}
            step={step}
            descriptor={descriptor}
            fullPath={descriptor.path}
            onChange={onChange}
            priorSteps={priorSteps}
            inputFields={inputFields}
            renderValue={renderValue}
            exampleFor={exampleFor}
          />
        );
      })}
    </Container>
  );
}
