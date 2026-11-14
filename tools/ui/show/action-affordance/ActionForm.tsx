// packages/ui/show/action-affordance/ActionForm.tsx
//
// The BLIND action input form. It knows NOTHING about any domain — no "image",
// no "model", no "size", no closed set of field kinds. It is handed a list of
// self-describing DATA field descriptors (AskField) and paints each one by
// looking its `control` up in a renderer registry, collecting the values into an
// ANSWERS bag. The answers bind into ANY of the workflow definitions via the
// invoking surface (ctx.answers → resolveBindingTemplate → dispatch).
//
// Because the form is DATA and the registry is an INJECTED capability map (not a
// core switch — enum-dissolution), one image-generation "modal", a one-line
// rename, a translate-with-options, and a thing nobody has invented yet are the
// SAME host over different DATA rows. Delete every example: the host still
// renders any descriptor set dropped in. Add a new control: register a renderer,
// never edit this file.

import React, { useMemo, useState } from 'react';
import { Button } from '../button';
import { Container } from '../container';
import { Text } from '../text';
import { Input, Textarea } from '../input';
import { later } from '../load-later/later';
const DatePicker = later(() => import('../date-picker/DatePicker'), module => module.DatePicker);
const DateTimePicker = later(() => import('../date-picker/DateTimePicker'), module => module.DateTimePicker);
const TimePicker = later(() => import('../date-picker/TimePicker'), module => module.TimePicker);
import { Dropdown } from '../dropdown';
import { Slider } from '../slider';
import { EntityPickerField } from './EntityPickerField';
import { BrowserFileField } from './browser-file-field';
import type { ActionConfigurationSchema, AskField, AskFieldOption } from './action-affordance-types';
import { getPath, setPath } from './read-action-affordances';
import { FloatingPanel } from '../../../screen-arrangement/show/FloatingPanel';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
/** What every control renderer receives. Pure props — the renderer never reads
 *  anything but the field descriptor, its current value, its resolved options,
 *  and the setter. */
export interface FieldRenderContext {
  readonly field: AskField;
  readonly value: unknown;
  readonly options: readonly AskFieldOption[];
  readonly setValue: (value: unknown) => void;
  readonly setValidity?: (valid: boolean) => void;
  readonly disabled?: boolean;
}

export type FieldRenderer = (ctx: FieldRenderContext) => React.ReactNode;

const asText = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const asNumber = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function coerceFieldValue(field: AskField, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (field.value_type === 'boolean') return value === 'true';
  if (field.value_type === 'number') return Number(value);
  if (field.value_type === 'integer') return Number.parseInt(value, 10);
  return value;
}

function cloneAnswerValue(value: unknown): unknown {
  if (typeof File !== 'undefined' && value instanceof File) return value;
  if (Array.isArray(value)) return value.map(cloneAnswerValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneAnswerValue(entry)]));
  }
  return value;
}

/** The DEFAULT control→renderer map. A convenience, NOT a closed union: callers
 *  merge their own renderers via the `renderers` prop, and any control key with
 *  no renderer falls through to the text renderer (never an error, never a
 *  special case — the closure test holds). */
export const DEFAULT_FIELD_RENDERERS: Record<string, FieldRenderer> = {
  date: ({field, value, setValue, disabled}) => (
    <DatePicker aria-label={field.label} value={asText(value) || null} disabled={disabled} allowClear={!field.required} onChange={setValue} />
  ),
  'datetime-local': ({field, value, setValue, setValidity, disabled}) => (
    <DateTimePicker aria-label={field.label} value={asText(value) || null} disabled={disabled} required={field.required} onChange={setValue} onValidityChange={setValidity} />
  ),
  time: ({field, value, setValue, setValidity, disabled}) => (
    <TimePicker aria-label={field.label} value={asText(value) || null} disabled={disabled} required={field.required} onChange={setValue} onValidityChange={setValidity} />
  ),
  text: ({ field, value, setValue, disabled }) => (
    <Textarea
      value={asText(value)}
      placeholder={field.placeholder ?? ''}
      rows={3}
      disabled={disabled}
      onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setValue(e.target.value)}
    />
  ),
  line: ({ field, value, setValue, disabled }) => (
    <Input
      value={asText(value)}
      placeholder={field.placeholder ?? ''}
      disabled={disabled}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
    />
  ),
  number: ({ field, value, setValue, disabled }) => (
    <Input
      type="number"
      value={asText(value)}
      placeholder={field.placeholder ?? ''}
      min={field.min}
      max={field.max}
      step={field.step}
      disabled={disabled}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(Number(e.target.value))}
    />
  ),
  select: ({ field, value, options, setValue, disabled }) => disabled ? (
    <Text variant="caption" tone="subtle">Available after its dependencies are complete.</Text>
  ) : (
    <Dropdown
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      value={asText(value)}
      onValueChange={(v: string) => setValue(v)}
      align="start"
      scrollable="50vh"
      aria-label={field.label}
    />
  ),
  // An open-set checkbox picker. Its choices are entirely field DATA; this
  // renderer is reusable wherever one operation needs one-or-more records.
  'multi-select': ({ field, value, options, setValue, disabled }) => {
    const selected = new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
    return disabled ? (
      <Text variant="caption" tone="subtle">Available after its dependencies are complete.</Text>
    ) : (
      <Container layout="vertical" gap="xs" role="group" aria-label={field.label}>
        {options.map((option) => {
          const checked = selected.has(option.value);
          return (
            <button
              key={option.value}
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-label={`${field.label}: ${option.label}`}
              onClick={() => {
                const next = new Set(selected);
                if (checked) next.delete(option.value);
                else next.add(option.value);
                setValue(options.filter((entry) => next.has(entry.value)).map((entry) => entry.value));
              }}
            >
              {checked ? '✓ ' : ''}{option.label}
            </button>
          );
        })}
      </Container>
    );
  },
  scale: ({ field, value, setValue }) => {
    const min = field.min ?? 0;
    const max = field.max ?? 100;
    const current = asNumber(value, min);
    return (
      <Container layout="vertical" gap="xs">
        <Slider
          value={current}
          min={min}
          max={max}
          step={field.step ?? 1}
          valueLabel=""
          onValueChange={(v: number) => setValue(v)}
        />
        {field.min_label || field.max_label ? (
          <Container layout="horizontal" justifyContent="between">
            <Text variant="caption" tone="subtle">{field.min_label ?? String(min)}</Text>
            <Text variant="caption" tone="subtle">{field.max_label ?? String(max)}</Text>
          </Container>
        ) : null}
      </Container>
    );
  },
};

// A select/reference with no renderer of its own reuses the select renderer;
// reference is just a select whose options come from a live address.
DEFAULT_FIELD_RENDERERS.choice = DEFAULT_FIELD_RENDERERS.select;
DEFAULT_FIELD_RENDERERS.reference = DEFAULT_FIELD_RENDERERS.select;
DEFAULT_FIELD_RENDERERS.slider = DEFAULT_FIELD_RENDERERS.scale;
DEFAULT_FIELD_RENDERERS.textarea = DEFAULT_FIELD_RENDERERS.text;
// A searchable entity picker for large live lists — search box + capped scroll
// list; the answer is the full picked option (callers can read `.record`). Any
// "pick one live record" field reuses it via `control: 'entity-picker'`.
DEFAULT_FIELD_RENDERERS['entity-picker'] = (ctx) => <EntityPickerField {...ctx} />;
DEFAULT_FIELD_RENDERERS['browser-file'] = (ctx) => <BrowserFileField {...ctx} />;

export interface ActionFieldProjection {
  readonly visible: readonly AskField[];
  readonly enabledIds: ReadonlySet<string>;
  readonly dependencyCycles: readonly string[];
}

function dependencyId(path: string): string {
  return path.split(/[.[\]]/, 1)[0] ?? path;
}

/** Stable answers → field projection. It is pure, source-agnostic, and detects
 * every dependency cycle before a control can dispatch. */
export function projectActionFields(
  fields: readonly AskField[],
  answers: Readonly<Record<string, unknown>>,
): ActionFieldProjection {
  const ids = new Set(fields.map((field) => field.id));
  const dependencies = new Map<string, string[]>();
  for (const field of fields) {
    const refs = new Set((field.depends_on ?? []).filter((id) => ids.has(id)));
    if (field.visible_when) refs.add(dependencyId(field.visible_when.path));
    if (field.enabled_when) refs.add(dependencyId(field.enabled_when.path));
    dependencies.set(field.id, [...refs].filter((id) => ids.has(id)));
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles = new Set<string>();
  const visit = (id: string, trail: readonly string[]) => {
    if (visiting.has(id)) {
      const start = trail.indexOf(id);
      cycles.add([...trail.slice(start), id].join(' → '));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const field of fields) visit(field.id, []);
  const visible = fields.filter((field) => (
    !field.visible_when || getPath(answers, field.visible_when.path) === field.visible_when.equals
  ));
  const enabledIds = new Set(visible
    .filter((field) => !field.enabled_when || getPath(answers, field.enabled_when.path) === field.enabled_when.equals)
    .map((field) => field.id));
  return { visible, enabledIds, dependencyCycles: [...cycles].sort() };
}

export interface ActionFormProps {
  readonly open: boolean;
  readonly title: string;
  readonly fields: readonly AskField[];
  /** Optional DATA-only arrangement metadata. It never changes binding or
   *  validation; it only groups the same fields into a subflow. */
  readonly schema?: ActionConfigurationSchema;
  /** Host-resolved defaults, including last-used answers and invoke-context
   *  bindings. The form does not persist or interpret them. */
  readonly initialValues?: Record<string, unknown>;
  /** Resolve a field's options (inline `options`, or a live list named by
   *  `options_address` — so Model/Skill reference ai-cli-launch-adapters/ai-instruction-blocks
   *  as DATA). Defaults to the field's inline options. */
  readonly optionsFor?: (field: AskField) => readonly AskFieldOption[];
  /** Run a field's `fill_action` (a nested definition run) and return the text
   *  to drop into that field — the "Generate prompt" / "Describe image" buttons,
   *  themselves just DATA, no field special-cased. */
  readonly onFill?: (field: AskField, answers: Record<string, unknown>) => Promise<string | null>;
  readonly onSubmit: (answers: Record<string, unknown>) => void | Promise<void>;
  /** Invoke a descriptor-selected owner materializer. Required when a field or
   * selected projected option declares one; absence fails visibly and closed. */
  readonly onMaterialize?: (request: {
    readonly field: AskField;
    readonly value: unknown;
    readonly answers: Readonly<Record<string, unknown>>;
    readonly descriptor: Readonly<Record<string, unknown>>;
  }) => Promise<unknown>;
  readonly onCancel: () => void;
  readonly submitLabel?: string;
  /** Injected capability map — merged over the defaults. Adding a control is a
   *  registration here, never an edit to this component. */
  readonly renderers?: Record<string, FieldRenderer>;
  /** When provided (and the action has fields), the form offers "Save as preset":
   *  the current answers become a named, reusable, MORE-specialized action. The
   *  form stays blind — it only hands back the name + answers; the surface owns
   *  currying (deriveActionPresetRecord) + the live write. Absent → no preset UI. */
  readonly onSavePreset?: (name: string, answers: Record<string, unknown>) => void;
}

/** Render a DATA form, collect answers, submit. Blind to every domain. */
export function ActionForm({
  open,
  title,
  fields,
  schema,
  initialValues,
  optionsFor,
  onFill,
  onSubmit,
  onMaterialize,
  onCancel,
  submitLabel = 'Run',
  renderers,
  onSavePreset,
}: ActionFormProps): React.ReactElement | null {
  const registry = useMemo(() => ({ ...DEFAULT_FIELD_RENDERERS, ...(renderers ?? {}) }), [renderers]);
  const [answers, setAnswers] = useState<Record<string, unknown>>(() => {
    const seed: Record<string, unknown> = {};
    for (const f of fields) if (f.default !== undefined) setPath(seed, f.answer_path ?? f.id, f.default);
    return { ...seed, ...(initialValues ?? {}) };
  });
  const [filling, setFilling] = useState<string | null>(null);
  // Save-as-preset is a two-step reveal: click "Save as preset" → a name row
  // appears → "Save" commits. Only offered when a save handler is wired AND the
  // action actually has fields to specialize (a fieldless action has no preset).
  const [namingPreset, setNamingPreset] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(() => new Set());
  if (!open) return null;
  const canSavePreset = Boolean(onSavePreset) && fields.length > 0;

  const set = (field: AskField, value: unknown) => setAnswers((prev) => {
    const next = { ...prev };
    setPath(next, field.answer_path ?? field.id, coerceFieldValue(field, value));
    return next;
  });
  const resolveOptions = (field: AskField) => optionsFor?.(field) ?? field.options ?? [];
  const projection = projectActionFields(fields, answers);
  const visible = (field: AskField) => projection.visible.includes(field)
    && (!field.hide_when_options_empty || resolveOptions(field).length > 0);
  const visibleFields = projection.visible.filter(visible);
  const unknownControls = visibleFields.filter((field) => !registry[field.control]);
  const canSubmit = !submitting
    && visibleFields.every(field => !projection.enabledIds.has(field.id) || !invalidFields.has(field.id))
    && projection.dependencyCycles.length === 0
    && unknownControls.length === 0
    && visibleFields.every((field) => !field.required || (
      projection.enabledIds.has(field.id)
      && (() => {
        const answer = getPath(answers, field.answer_path ?? field.id);
        return answer !== undefined && answer !== null && answer !== '' && (!Array.isArray(answer) || answer.length > 0);
      })()
    ));

  const byId = new Map(fields.map((field) => [field.id, field]));
  const assigned = new Set<string>();
  for (const step of schema?.steps ?? []) for (const id of step.field_ids ?? []) assigned.add(id);
  for (const id of schema?.advanced?.field_ids ?? []) assigned.add(id);
  const fieldsFor = (ids: readonly string[] | undefined): AskField[] =>
    (ids ?? []).map((id) => byId.get(id)).filter((field): field is AskField => field !== undefined && visible(field));
  const ungroupedFields = visibleFields.filter((field) => !assigned.has(field.id));
  const renderField = (field: AskField) => {
    const render = registry[field.control];
    if (!render) {
      return <Text key={field.id} variant="body-xs" color="error">This field type isn’t available here.</Text>;
    }
    const disabled = !projection.enabledIds.has(field.id);
    return (
      <Container key={field.id} layout="vertical" gap="xs">
        <Container layout="horizontal" justifyContent="between" alignItems="center">
          <Text variant="label">{field.label}</Text>
          {field.fill_action ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={filling === field.id}
              onClick={() => runFill(field)}
            >
              {filling === field.id ? '…' : (field.fill_action.label ?? 'Generate')}
            </Button>
          ) : null}
        </Container>
        {disabled
          ? <Text variant="caption" tone="subtle">Available after its dependencies are complete.</Text>
          : render({ field, value: getPath(answers, field.answer_path ?? field.id), options: resolveOptions(field), setValue: (v) => set(field, v), disabled,
              setValidity: valid => setInvalidFields(current => { if (current.has(field.id) === !valid) return current; const next = new Set(current); if (valid) next.delete(field.id); else next.add(field.id); return next; }) })}
        {field.help ? <Text variant="caption" tone="subtle">{field.help}</Text> : null}
      </Container>
    );
  };
  const previewFields = fieldsFor(schema?.preview?.field_ids);
  const previewValue = (field: AskField): string => {
    const value = getPath(answers, field.answer_path ?? field.id);
    if (value && typeof value === 'object' && 'label' in (value as Record<string, unknown>)) {
      return String((value as Record<string, unknown>).label ?? '');
    }
    const option = resolveOptions(field).find((entry) => entry.value === value);
    return option?.label ?? (value == null ? '' : String(value));
  };

  const runFill = async (field: AskField) => {
    if (!onFill) return;
    setFilling(field.id);
    try {
      const text = await onFill(field, answers);
      if (typeof text === 'string' && text.length > 0) set(field, text);
    } finally {
      setFilling(null);
    }
  };

  const materializerOf = (field: AskField, value: unknown): Readonly<Record<string, unknown>> | null => {
    if (field.materializer) return field.materializer;
    if (!value || typeof value !== 'object') return null;
    const record = (value as { record?: unknown }).record;
    const payload = record && typeof record === 'object' && 'payload' in record
      ? (record as { payload?: unknown }).payload
      : record;
    if (!payload || typeof payload !== 'object') return null;
    const descriptor = (payload as { materializer?: unknown }).materializer;
    return descriptor && typeof descriptor === 'object' ? descriptor as Readonly<Record<string, unknown>> : null;
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmissionError(null);
    setSubmitting(true);
    try {
      const materialized = cloneAnswerValue(answers) as Record<string, unknown>;
      for (const field of visibleFields) {
        const path = field.answer_path ?? field.id;
        const value = getPath(answers, path);
        const descriptor = materializerOf(field, value);
        if (!descriptor) continue;
        if (!onMaterialize) throw new Error(`No owner materializer dispatcher is available for ${field.label}.`);
        const output = await onMaterialize({ field, value, answers, descriptor });
        setPath(materialized, path, output);
      }
      await onSubmit(materialized);
    } catch (error) {
      setSubmissionError(errorWords(error, 'The action could not be materialized.'));
      throw error; // The shared Button consumes the rejection and reports failure instead of a false Done.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FloatingPanel open onClose={onCancel} title={title}>
      <Container layout="vertical" gap="md" padding="md">
        {schema?.steps?.map((step) => (
          <Container key={step.id} layout="vertical" gap="sm">
            <Container layout="vertical" gap="xs">
              <Text variant="heading">{step.label}</Text>
              {step.description ? <Text variant="caption" tone="subtle">{step.description}</Text> : null}
            </Container>
            {fieldsFor(step.field_ids).map(renderField)}
          </Container>
        ))}
        {ungroupedFields.map(renderField)}
        {schema?.advanced ? (
          <details>
            <summary>{schema.advanced.label ?? 'Advanced'}</summary>
            <Container layout="vertical" gap="sm" padding="sm">
              {fieldsFor(schema.advanced.field_ids).map(renderField)}
            </Container>
          </details>
        ) : null}
        {schema?.preview && previewFields.length > 0 ? (
          <Container layout="vertical" gap="xs">
            <Text variant="label">{schema.preview.label ?? 'Preview'}</Text>
            {previewFields.map((field) => (
              <Container key={field.id} layout="horizontal" justifyContent="between" gap="sm">
                <Text variant="caption" tone="subtle">{field.label}</Text>
                <Text variant="caption">{previewValue(field)}</Text>
              </Container>
            ))}
          </Container>
        ) : null}
        {projection.dependencyCycles.length > 0 ? (
          <Text variant="body-xs" color="error">This form can’t open because some fields depend on each other.</Text>
        ) : null}
        {submissionError ? <Text variant="body-xs" color="error">{submissionError}</Text> : null}
        {namingPreset ? (
          <Container layout="horizontal" gap="sm" alignItems="center">
            <Input
              value={presetName}
              placeholder="Preset name (e.g. Formal & tight)"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPresetName(e.target.value)}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={presetName.trim().length === 0}
              onClick={() => {
                onSavePreset?.(presetName.trim(), answers);
                setNamingPreset(false);
                setPresetName('');
              }}
            >
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setNamingPreset(false); setPresetName(''); }}>
              Cancel
            </Button>
          </Container>
        ) : null}
        <Container layout="horizontal" gap="sm" justifyContent="between" alignItems="center">
          {canSavePreset && !namingPreset ? (
            <Button variant="ghost" size="sm" onClick={() => setNamingPreset(true)}>Save as preset</Button>
          ) : <span />}
          <Container layout="horizontal" gap="sm" justifyContent="end">
            <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={!canSubmit} onClick={() => submit()}>{submitting ? '…' : submitLabel}</Button>
          </Container>
        </Container>
      </Container>
    </FloatingPanel>
  );
}
