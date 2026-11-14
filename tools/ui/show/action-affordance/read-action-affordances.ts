// packages/ui/show/action-affordance/read-action-affordances.ts
//
// Pure decode + filter + binding resolution for action-affordance published
// records. Mirrors placeable-surface-record.ts: tolerate anything, throw never,
// skip invalid rows. Zero I/O, zero React, zero runtime-kit — hosts own reads,
// writes, and dispatch senders.

import type { PublishedRecord } from '../placeable-surface-intent/placeable-surface-record';
import type {
  ActionAffordance,
  ActionAffordanceAsk,
  ActionConfigurationSchema,
  ActionAffordanceCondition,
  ActionAffordanceDispatch,
  ActionAffordanceTrigger,
  AffordanceInvokeContext,
  AskField,
} from './action-affordance-types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readAskField(value: unknown): AskField | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const control = readString(value.control);
  const label = readString(value.label);
  if (!id || !control || !label) return null;
  const options = Array.isArray(value.options)
    ? value.options
        .map((o) => (isRecord(o) && readString(o.value) !== null && readString(o.label) !== null
          ? { value: readString(o.value) as string, label: readString(o.label) as string }
          : null))
        .filter((o): o is { value: string; label: string } => o !== null)
    : undefined;
  return {
    id,
    control,
    label,
    ...(readString(value.value_type) ? { value_type: readString(value.value_type) as string } : {}),
    ...(readString(value.placeholder) ? { placeholder: readString(value.placeholder) as string } : {}),
    ...(readString(value.help) ? { help: readString(value.help) as string } : {}),
    ...(options && options.length ? { options } : {}),
    ...(readString(value.options_address) ? { options_address: readString(value.options_address) as string } : {}),
    ...(value.hide_when_options_empty === true ? { hide_when_options_empty: true } : {}),
    ...(isRecord(value.options_source) ? { options_source: value.options_source } : {}),
    ...(isRecord(value.options_filter) && readString(value.options_filter.path)
      ? { options_filter: {
          path: readString(value.options_filter.path) as string,
          ...(readString(value.options_filter.includes) ? { includes: readString(value.options_filter.includes) as string } : {}),
          ...(value.options_filter.equals !== undefined ? { equals: value.options_filter.equals } : {}),
        } }
      : {}),
    ...(typeof value.min === 'number' ? { min: value.min } : {}),
    ...(typeof value.max === 'number' ? { max: value.max } : {}),
    ...(typeof value.step === 'number' ? { step: value.step } : {}),
    ...(readString(value.min_label) ? { min_label: readString(value.min_label) as string } : {}),
    ...(readString(value.max_label) ? { max_label: readString(value.max_label) as string } : {}),
    ...(value.default !== undefined ? { default: value.default } : {}),
    ...(isRecord(value.default_binding) ? { default_binding: value.default_binding } : {}),
    ...(readString(value.default_option) ? { default_option: readString(value.default_option) as string } : {}),
    ...(readString(value.answer_path) ? { answer_path: readString(value.answer_path) as string } : {}),
    ...(value.required === true ? { required: true } : {}),
    ...(Array.isArray(value.depends_on)
      ? { depends_on: value.depends_on.map(readString).filter((id): id is string => id !== null) }
      : {}),
    ...(isRecord(value.visible_when) && readString(value.visible_when.path)
      ? {
          visible_when: {
            path: readString(value.visible_when.path) as string,
            equals: value.visible_when.equals,
          },
        }
      : {}),
    ...(isRecord(value.enabled_when) && readString(value.enabled_when.path)
      ? {
          enabled_when: {
            path: readString(value.enabled_when.path) as string,
            equals: value.enabled_when.equals,
          },
        }
      : {}),
    ...(isRecord(value.materializer) && readString(value.materializer.target)
      ? { materializer: value.materializer as AskField['materializer'] }
      : {}),
    ...(isRecord(value.fill_action) && readString(value.fill_action.definition_id)
      ? { fill_action: { definition_id: readString(value.fill_action.definition_id) as string,
          ...(readString(value.fill_action.label) ? { label: readString(value.fill_action.label) as string } : {}) } }
      : {}),
  };
}

function readConfiguration(value: unknown): ActionConfigurationSchema | undefined {
  if (!isRecord(value)) return undefined;
  const steps = Array.isArray(value.steps)
    ? value.steps.map((step) => {
        if (!isRecord(step) || !readString(step.id) || !readString(step.label)) return null;
        const fieldIds = Array.isArray(step.field_ids)
          ? step.field_ids.map(readString).filter((id): id is string => id !== null)
          : [];
        return {
          id: readString(step.id) as string,
          label: readString(step.label) as string,
          ...(readString(step.description) ? { description: readString(step.description) as string } : {}),
          ...(fieldIds.length ? { field_ids: fieldIds } : {}),
        };
      }).filter((step): step is NonNullable<typeof step> => step !== null)
    : [];
  const readFieldIds = (raw: unknown) => Array.isArray(raw)
    ? raw.map(readString).filter((id): id is string => id !== null)
    : [];
  const advanced = isRecord(value.advanced)
    ? { ...(readString(value.advanced.label) ? { label: readString(value.advanced.label) as string } : {}),
        ...(readFieldIds(value.advanced.field_ids).length ? { field_ids: readFieldIds(value.advanced.field_ids) } : {}) }
    : undefined;
  const preview = isRecord(value.preview)
    ? { ...(readString(value.preview.label) ? { label: readString(value.preview.label) as string } : {}),
        ...(readFieldIds(value.preview.field_ids).length ? { field_ids: readFieldIds(value.preview.field_ids) } : {}) }
    : undefined;
  const dynamicFields = Array.isArray(value.dynamic_fields)
    ? value.dynamic_fields.map((source) => {
        if (!isRecord(source)) return null;
        const id = readString(source.id);
        const sourceFieldId = readString(source.source_field_id);
        const sourceRecordPath = readString(source.source_record_path);
        const answerPrefix = readString(source.answer_prefix);
        if (!id || !sourceFieldId || !sourceRecordPath || !answerPrefix) return null;
        return {
          id,
          source_field_id: sourceFieldId,
          source_record_path: sourceRecordPath,
          answer_prefix: answerPrefix,
          ...(readString(source.field_id_prefix)
            ? { field_id_prefix: readString(source.field_id_prefix) as string }
            : {}),
        };
      }).filter((source): source is NonNullable<typeof source> => source !== null)
    : [];
  if (!steps.length && !advanced && !preview && !dynamicFields.length && typeof value.version !== 'number') return undefined;
  return {
    ...(typeof value.version === 'number' ? { version: value.version } : {}),
    ...(steps.length ? { steps } : {}),
    ...(advanced ? { advanced } : {}),
    ...(preview ? { preview } : {}),
    ...(dynamicFields.length ? { dynamic_fields: dynamicFields } : {}),
  };
}

function readTrigger(value: unknown): ActionAffordanceTrigger | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const channel = readString(value.channel);
  if (!id || !channel) return null;
  // `ask` carries the one-line `prompt` shorthand and/or a `fields` form — both
  // DATA, decoded tolerantly. Present only when it has real content.
  const askRaw = isRecord(value.ask) ? value.ask : null;
  const prompt = askRaw ? readString(askRaw.prompt) : null;
  const fields = askRaw && Array.isArray(askRaw.fields)
    ? askRaw.fields.map(readAskField).filter((f): f is AskField => f !== null)
    : [];
  const configuration = askRaw ? readConfiguration(askRaw.configuration) : undefined;
  const ask = prompt || fields.length || configuration
    ? {
        ...(prompt ? { prompt } : {}),
        ...(askRaw && readString(askRaw.title) ? { title: readString(askRaw.title) as string } : {}),
        ...(fields.length ? { fields } : {}),
        ...(askRaw && readString(askRaw.submit_label) ? { submit_label: readString(askRaw.submit_label) as string } : {}),
        ...(configuration ? { configuration } : {}),
      }
    : undefined;
  // `contexts` narrows the trigger to placement scopes WITHIN the channel —
  // an open string list (DATA). Present only with real content; absent keeps
  // the host channel's default placement (back-compat).
  const contexts = Array.isArray(value.contexts)
    ? value.contexts.map(readString).filter((c): c is string => c !== null)
    : [];
  return {
    id,
    channel,
    ...(contexts.length ? { contexts } : {}),
    ...(readString(value.event) ? { event: readString(value.event) as string } : {}),
    ...(ask ? { ask } : {}),
    input_template: isRecord(value.input_template) ? value.input_template : {},
    ...(isRecord(value.presentation) ? { presentation: value.presentation } : {}),
  };
}

function readDispatch(value: unknown): ActionAffordanceDispatch | null {
  if (!isRecord(value)) return null;
  const target = readString(value.target);
  if (!target || !isRecord(value.payload_template)) return null;
  const rawStatus = value.status;
  const status = isRecord(rawStatus)
    && readString(rawStatus.result_address_template)
    && readString(rawStatus.error_address_template)
    ? {
        result_address_template: rawStatus.result_address_template as string,
        error_address_template: rawStatus.error_address_template as string,
        ...(rawStatus.address_mode === 'label-hash' || rawStatus.address_mode === 'identity-text'
          ? { address_mode: rawStatus.address_mode }
          : {}),
        ...(readString(rawStatus.result_partition_label)
          ? { result_partition_label: rawStatus.result_partition_label as string }
          : {}),
      }
    : undefined;
  return { target, payload_template: value.payload_template, ...(status ? { status } : {}) };
}

function readConditions(value: unknown): ReadonlyArray<ActionAffordanceCondition> | null {
  if (!isRecord(value) || !Array.isArray(value.conditions)) return null;
  const rows: ActionAffordanceCondition[] = [];
  for (const row of value.conditions) {
    if (!isRecord(row)) continue;
    const path = readString(row.path);
    if (!path) continue;
    rows.push({ path, equals: row.equals });
  }
  return rows;
}

function affordanceFrom(payload: unknown, sourceAddress?: string): ActionAffordance | null {
  if (!isRecord(payload) || payload.kind !== 'action-affordance') return null;
  if (payload.is_active === false) return null;
  const id = readString(payload.id);
  const label = readString(payload.label);
  const dispatch = readDispatch(payload.dispatch);
  if (!id || !label || !dispatch) return null;
  const triggers = Array.isArray(payload.triggers)
    ? payload.triggers.map(readTrigger).filter((t): t is ActionAffordanceTrigger => t !== null)
    : [];
  const conditions = readConditions(payload.accepts);
  const outputKind = isRecord(payload.output_contract) ? readString(payload.output_contract.kind) : null;
  return {
    id,
    version: typeof payload.version === 'number' ? payload.version : 1,
    is_active: true,
    label,
    ...(readString(payload.icon) ? { icon: readString(payload.icon) as string } : {}),
    ...(readString(payload.hint) ? { hint: readString(payload.hint) as string } : {}),
    ...(readString(payload.section) ? { section: readString(payload.section) as string } : {}),
    ...(typeof payload.priority === 'number' ? { priority: payload.priority } : {}),
    ...(readString(payload.effect) ? { effect: readString(payload.effect) as string } : {}),
    ...(conditions ? { accepts: { conditions } } : {}),
    triggers,
    dispatch,
    ...(outputKind
      ? {
          output_contract: {
            kind: outputKind,
            ...(readString((payload.output_contract as Record<string, unknown>).artifacts_path)
              ? { artifacts_path: readString((payload.output_contract as Record<string, unknown>).artifacts_path) as string }
              : {}),
          },
        }
      : {}),
    payload,
    ...(sourceAddress ? { source_address: sourceAddress } : {}),
  };
}

/** Decode every action-affordance row out of published records. Invalid or
 *  inactive rows are skipped — never thrown on. */
export function readActionAffordances(records: readonly PublishedRecord[]): ActionAffordance[] {
  const rows: ActionAffordance[] = [];
  for (const record of records) {
    const decoded = affordanceFrom(record.payload, record.recordId);
    if (decoded) rows.push(decoded);
  }
  return rows;
}

/** Decode the ARCHIVED (is_active:false) action-affordance rows — the soft-deleted
 *  records `readActionAffordances` deliberately skips. This is what makes archive
 *  recoverable BEYOND the transient Undo notice: a surface lists these and restores
 *  via the liveness primitive (`setActionAffordanceActiveLive(ref, true)`). Same
 *  decode, same validation; only the liveness filter flips — the returned row keeps
 *  `is_active:false` (and the ORIGINAL payload bytes) so a restore rewrites exactly
 *  what was archived. Invalid rows skipped, never thrown on. */
export function readArchivedActionAffordances(records: readonly PublishedRecord[]): ActionAffordance[] {
  const rows: ActionAffordance[] = [];
  for (const record of records) {
    const payload = record.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const raw = payload as Record<string, unknown>;
    if (raw.kind !== 'action-affordance' || raw.is_active !== false) continue;
    // Reuse the ONE decoder by flipping liveness for the decode pass only.
    const decoded = affordanceFrom({ ...raw, is_active: true }, record.recordId);
    if (decoded) rows.push({ ...decoded, is_active: false, payload });
  }
  return rows;
}

/** Fold the latest user configuration record per action. Configuration is a
 *  generic affordance primitive, not a Documents preference; any
 * surface can read the same published feed and reuse the last valid answers. */
export function readActionAffordanceConfigurations(
  records: readonly PublishedRecord[],
): Record<string, Record<string, unknown>> {
  const latest: Record<string, Record<string, unknown>> = {};
  for (const record of records) {
    if (!isRecord(record.payload) || record.payload.kind !== 'action-affordance-configuration') continue;
    const actionId = readString(record.payload.action_id);
    const answers = isRecord(record.payload.answers) ? record.payload.answers : null;
    if (actionId && answers) latest[actionId] = answers;
  }
  return latest;
}

/** Dotted-path read over an opaque bag ('a.b.0.c'). Missing → undefined. */
export function getPath(source: unknown, path: string): unknown {
  if (!path) return source;
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Dotted-path write used by schema-projected fields. It creates only plain
 * objects, preserving the host's opaque answer bag without domain knowledge. */
export function setPath(source: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  if (!parts.length) return;
  let current = source;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isRecord(next)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function deletePath(source: Record<string, unknown>, path: string): void {
  const parts = path.split('.').filter(Boolean);
  if (!parts.length) return;
  let current: unknown = source;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(current)) return;
    current = current[part];
  }
  if (isRecord(current)) delete current[parts[parts.length - 1]];
}

function answerPath(field: AskField): string {
  return field.answer_path ?? field.id;
}

export type AskFieldOptionsResolver = (field: AskField) => readonly { value: string; label: string; record?: unknown }[];

/** The one field collection seam. Configuration metadata can arrange the same
 *  fields into steps/groups without creating a second field vocabulary. */
export function actionFieldsForAsk(ask: ActionAffordanceAsk | undefined): readonly AskField[] {
  return ask?.fields ?? [];
}

function humanizeFieldId(value: string): string {
  return value.split(/[-_\s]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function selectedOption(
  field: AskField,
  answers: Record<string, unknown>,
  optionsFor: AskFieldOptionsResolver,
): { value: string; label: string; record?: unknown } | null {
  const selected = getPath(answers, answerPath(field));
  const selectedValue = isRecord(selected) && typeof selected.value === 'string' ? selected.value : selected;
  if (typeof selectedValue !== 'string') return null;
  return optionsFor(field).find((option) => option.value === selectedValue) ?? null;
}

function schemaControl(spec: Record<string, unknown>): string {
  const ui = isRecord(spec.ui) ? readString(spec.ui.control) : null;
  if (ui) return ui;
  if (Array.isArray(spec.enum)) return 'select';
  if (spec.type === 'number' || spec.type === 'integer') return 'number';
  return 'line';
}

/** Expand record-backed JSON-schema properties into the same AskField
 *  vocabulary as static fields. This is the generic UI translation boundary:
 *  product keys and destination names are never inspected here. */
export function resolveActionAskFields(
  ask: ActionAffordanceAsk | undefined,
  answers: Record<string, unknown>,
  optionsFor?: AskFieldOptionsResolver,
): readonly AskField[] {
  if (!ask) return [];
  const base = [...actionFieldsForAsk(ask)];
  if (!optionsFor || !ask.configuration?.dynamic_fields?.length) return base;
  for (const source of ask.configuration.dynamic_fields) {
    const sourceField = base.find((field) => field.id === source.source_field_id);
    if (!sourceField) continue;
    const option = selectedOption(sourceField, answers, optionsFor);
    const record = option?.record;
    const schema = getPath(record, source.source_record_path);
    if (!isRecord(schema) || !isRecord(schema.properties)) continue;
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
    for (const [property, rawSpec] of Object.entries(schema.properties)) {
      if (!isRecord(rawSpec)) continue;
      const fieldId = `${source.field_id_prefix ?? `${source.id}.`}${property}`;
      const propertyOptions = Array.isArray(rawSpec.enum)
        ? rawSpec.enum
            .filter((entry): entry is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof entry))
            .map((entry) => ({ value: String(entry), label: humanizeFieldId(String(entry)) }))
        : undefined;
      base.push({
        id: fieldId,
        answer_path: `${source.answer_prefix}.${property}`,
        control: schemaControl(rawSpec),
        label: readString(rawSpec.title) ?? humanizeFieldId(property),
        ...(typeof rawSpec.type === 'string' ? { value_type: rawSpec.type } : {}),
        ...(readString(rawSpec.description) ? { help: readString(rawSpec.description) as string } : {}),
        ...(propertyOptions?.length ? { options: propertyOptions } : {}),
        ...(rawSpec.default !== undefined ? { default: rawSpec.default } : {}),
        ...(required.has(property) ? { required: true } : {}),
      });
    }
  }
  return base;
}

/** Preserve the action's original metadata while replacing its field list
 *  with the currently selected record-schema projection. */
export function resolveActionAsk(
  ask: ActionAffordanceAsk | undefined,
  answers: Record<string, unknown>,
  optionsFor?: AskFieldOptionsResolver,
): ActionAffordanceAsk | undefined {
  if (!ask) return undefined;
  return { ...ask, fields: resolveActionAskFields(ask, answers, optionsFor) };
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
}

/** Seed a configuration from DATA defaults, the user's last valid answers, and
 *  the current invoke context. Context bindings win for the current source;
 *  this keeps a new document's request fresh while retaining the last target. */
export function resolveActionAskInitialAnswers(
  ask: ActionAffordanceAsk | undefined,
  context: AffordanceInvokeContext,
  optionsFor?: AskFieldOptionsResolver,
  persisted?: Record<string, unknown>,
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const field of actionFieldsForAsk(ask)) {
    if (field.default !== undefined) setPath(answers, answerPath(field), field.default);
  }
  for (const [id, value] of Object.entries(persisted ?? {})) {
    if (hasValue(value)) setPath(answers, id, value);
  }
  for (const field of actionFieldsForAsk(ask)) {
    const options = optionsFor?.(field) ?? [];
    const path = answerPath(field);
    const current = getPath(answers, path);
    if (options.length && hasValue(current)) {
      const selected = current;
      const selectedValue = isRecord(selected) && typeof selected.value === 'string'
        ? selected.value
        : selected;
      if (!options.some((option) => option.value === selectedValue)) deletePath(answers, path);
    }
    if (field.default_binding) {
      const value = resolveBindingTemplate(field.default_binding, context);
      if (hasValue(value)) setPath(answers, path, value);
    }
    if (!hasValue(getPath(answers, path)) && field.default_option === 'first') {
      const first = options[0];
      if (first) setPath(answers, path, field.control === 'entity-picker' ? first : first.value);
    }
  }
  return answers;
}

/** Fast-path validity is structural: every required DATA field has a value.
 *  No action, field id, or destination is known here. */
export function actionAskHasRequiredAnswers(
  ask: ActionAffordanceAsk | undefined,
  answers: Record<string, unknown>,
  optionsFor?: AskFieldOptionsResolver,
): boolean {
  return actionFieldsForAsk(ask).every((field) => {
    if (field.visible_when && getPath(answers, field.visible_when.path) !== field.visible_when.equals) {
      return true;
    }
    if (field.enabled_when && getPath(answers, field.enabled_when.path) !== field.enabled_when.equals) {
      return !field.required;
    }
    const path = answerPath(field);
    if (field.required && !hasValue(getPath(answers, path))) return false;
    const options = optionsFor?.(field) ?? [];
    const current = getPath(answers, path);
    if (!options.length || !hasValue(current)) return true;
    const selectedValues = (Array.isArray(current) ? current : [current]).map((selected) => (
      isRecord(selected) && typeof selected.value === 'string' ? selected.value : selected
    ));
    return selectedValues.length > 0 && selectedValues.every((selected) => options.some((option) => option.value === selected));
  });
}

/** A host's placement scope WITHIN a channel. `context` is the scope the host
 *  is rendering right now; `defaultContext` is the scope an UNSCOPED trigger
 *  belongs to — both host-supplied strings (the host's own vocabulary, DATA).
 *  This module never enumerates scopes (L090). */
export interface ChannelPlacement {
  readonly context: string;
  readonly defaultContext: string;
}

/** True when `trigger` belongs to the placement the host is rendering. No
 *  placement asked → the host renders the whole channel (every trigger, the
 *  pre-placement behavior). A trigger with no declared `contexts` belongs to
 *  the host's `defaultContext` — so legacy records keep their placement
 *  unchanged, mechanically. */
function triggerInPlacement(
  trigger: ActionAffordanceTrigger,
  placement?: ChannelPlacement,
): boolean {
  if (!placement) return true;
  const declared = trigger.contexts?.length ? trigger.contexts : [placement.defaultContext];
  return declared.includes(placement.context);
}

/** Every affordance carrying a trigger on `channel` (and, when asked, in
 *  `placement`), whose accepts.conditions all hold against `context`, sorted
 *  by priority then label. */
export function affordancesForChannel(
  all: readonly ActionAffordance[],
  channel: string,
  context: Record<string, unknown> = {},
  placement?: ChannelPlacement,
): ActionAffordance[] {
  return all
    .filter((a) => a.triggers.some((t) => t.channel === channel && triggerInPlacement(t, placement)))
    .filter((a) => (a.accepts?.conditions ?? []).every((c) => getPath(context, c.path) === c.equals))
    .sort((x, y) => (x.priority ?? 0) - (y.priority ?? 0) || x.label.localeCompare(y.label));
}

/** The trigger of `affordance` bound to `channel` (first match; scoped to
 *  `placement` when the host asks by placement). */
export function triggerForChannel(
  affordance: ActionAffordance,
  channel: string,
  placement?: ChannelPlacement,
): ActionAffordanceTrigger | null {
  return affordance.triggers.find((t) => t.channel === channel && triggerInPlacement(t, placement)) ?? null;
}

/** Coerce a resolved template part to the string a `template` composition
 *  concatenates. Missing (undefined/null) → '' so an unfilled binding drops out
 *  cleanly; primitives stringify; objects fall back to JSON. */
function stringifyPart(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/** Resolve a binding template against the invoke context.
 *   • `{ $kind:'binding', select:{ from, path } }` → `getPath(ctx[from], path)`;
 *   • `{ $kind:'template', parts:[…] }` → each part resolved, stringified, and
 *     concatenated into ONE string. This is the generative primitive behind
 *     "a stored instruction + the block content": the instruction is a literal
 *     string part, the content is a binding part, and the AI prompt is their
 *     composition — no field is special-cased, and a part can itself be another
 *     binding/template (parts recurse), so instruction+content+typed compose for
 *     free (L069/L090). Parts hold literal strings directly (no `literal` kind);
 *   • `{ $kind:'group', parts:[…] }` → like `template`, but the whole group
 *     resolves to '' unless at least one BINDING part produced content. This is
 *     how DATA carries framing prose around optional facts ("Document title: " +
 *     title-binding) without the prose leaking when the fact is absent — an
 *     empty title yields '', not a dangling "Document title: " label. A group
 *     with no binding parts is all-literal framing and keeps its text (there is
 *     nothing to be conditional ON). Nesting recurses: an inner group/template
 *     counts as content only if it resolved non-empty.
 *   • arrays and plain objects recurse; every other value passes through.
 *  The resolver reads `ctx[from]` generically — no enumeration of sources. */
export function resolveBindingTemplate(template: unknown, ctx: AffordanceInvokeContext): unknown {
  if (Array.isArray(template)) return template.map((v) => resolveBindingTemplate(v, ctx));
  if (isRecord(template)) {
    // Conditional composition is DATA. A missing chosen branch resolves to
    // undefined, which JSON serialization omits from its parent object. This
    // lets one form select between mutually exclusive descriptor shapes
    // without a domain-specific host branch.
    if (template.$kind === 'when' && isRecord(template.select)) {
      const from = readString(template.select.from) ?? '';
      const path = typeof template.select.path === 'string' ? template.select.path : '';
      const matches = getPath((ctx as unknown as Record<string, unknown>)[from], path) === template.equals;
      const branch = matches ? template.then : template.otherwise;
      return branch === undefined ? undefined : resolveBindingTemplate(branch, ctx);
    }
    if (template.$kind === 'binding' && isRecord(template.select)) {
      const from = readString(template.select.from) ?? '';
      const path = typeof template.select.path === 'string' ? template.select.path : '';
      return getPath((ctx as unknown as Record<string, unknown>)[from], path);
    }
    if (template.$kind === 'template' && Array.isArray(template.parts)) {
      return template.parts.map((part) => stringifyPart(resolveBindingTemplate(part, ctx))).join('');
    }
    if (template.$kind === 'group' && Array.isArray(template.parts)) {
      let bound = false;
      let produced = false;
      const resolved = template.parts.map((part) => {
        const isBindingLike = isRecord(part) && (part.$kind === 'binding' || part.$kind === 'group' || part.$kind === 'template');
        const text = stringifyPart(resolveBindingTemplate(part, ctx));
        if (isBindingLike) {
          bound = true;
          if (text !== '') produced = true;
        }
        return text;
      });
      return bound && !produced ? '' : resolved.join('');
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) out[key] = resolveBindingTemplate(value, ctx);
    return out;
  }
  return template;
}

/** A run's RESOLVED status addresses (templates filled with the run id) —
 *  the polling contract a host consults with its own reader. */
export interface ResolvedStatusAddresses {
  readonly resultAddress: string;
  readonly errorAddress: string;
  readonly addressMode?: 'label-hash' | 'identity-text';
  readonly resultPartitionLabel?: string;
}

/** Fill a dispatch's status templates with the run id. Null when the
 *  affordance declares no status (fire-and-forget). */
export function resolveStatusAddresses(
  affordance: ActionAffordance,
  runId: string,
): ResolvedStatusAddresses | null {
  const status = affordance.dispatch.status;
  if (!status) return null;
  return {
    resultAddress: status.result_address_template.split('{id}').join(runId),
    errorAddress: status.error_address_template.split('{id}').join(runId),
    ...(status.address_mode ? { addressMode: status.address_mode } : {}),
    ...(status.result_partition_label ? { resultPartitionLabel: status.result_partition_label } : {}),
  };
}

/** Resolve the chosen trigger's input, then the dispatch payload (which may
 *  bind `{ from:'trigger', path:'input' }`). Returns the envelope the host
 *  hands its injected sender. */
export function buildDispatchPayload(
  affordance: ActionAffordance,
  triggerId: string,
  ctx: AffordanceInvokeContext,
): { target: string; payload: unknown } {
  const trigger = affordance.triggers.find((t) => t.id === triggerId) ?? affordance.triggers[0];
  const input = trigger ? resolveBindingTemplate(trigger.input_template, ctx) : {};
  const withTrigger: AffordanceInvokeContext = { ...ctx, trigger: { input } };
  return {
    target: affordance.dispatch.target,
    payload: resolveBindingTemplate(affordance.dispatch.payload_template, withTrigger),
  };
}
