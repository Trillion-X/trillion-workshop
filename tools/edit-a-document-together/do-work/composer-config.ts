// packages/documents/do-work/composer-config.ts
//
// The composer's DISCLOSURE CONFIG rail — resolves the shortcut row's
// `presentation.config` DATA into options, the current choice, and the select
// dispatch. The surface renders what this returns and never names a kind, a
// target, a definition id, or a query: every name lives in the DATA row
// (L090 / enum-dissolution / no-god-package — the owning package's records
// carry the choice; this package only dispatches the row's declared action by
// address). A package can point the SAME panel at any other option catalog
// (voices, styles, output kinds) by shipping a different config bag.
//
// PRODUCT-LANGUAGE contract (L114/L118, user correction 2026-07-10): an option
// row is listed ONLY when it resolves a human label at the DATA-declared
// label_path — a record that carries nothing but a machine id is not part of
// the human catalog and is skipped, never shown as its raw id. Rows may also
// be excluded by DATA (`exclude`: retracted/retired flags). Each option can
// carry a description (a second dim line) and REF ANNOTATIONS — a field on the
// option that points at ANOTHER record (e.g. a model ref) is resolved to that
// record's own label from the same live feed, so the row can honestly show
// "what this choice runs on" with zero hardcoded vocabulary.

import { sendRequestToBitfieldTarget } from '#workspace-records';
import { buildEngineWriteBatchRequestFromLabels } from '#workspace-records';
import { resolveBindingTemplate } from '../../ui/show/action-affordance';

export type ComposerConfigSender = (request: { target: string; payload: unknown }) => Promise<unknown>;

export interface ComposerConfigOption {
  readonly value: string;
  readonly label: string;
  /** Second dim line under the label (from the DATA description_path). */
  readonly description?: string;
  /** Right-aligned dim annotation (ref_annotations resolved to the target record's label). */
  readonly annotation?: string;
}

export interface ComposerConfigView {
  /** Panel heading (user language, from DATA). */
  readonly title: string;
  /** DATA-declared option rows resolved from the live published-records stream. */
  readonly options: ComposerConfigOption[];
  /** An optional leading option representing "no explicit choice" (downstream
   *  resolution applies its own fallback). Purely DATA — absent means none. */
  readonly defaultOption: ComposerConfigOption | null;
  /** The row's writing instructions preamble (DATA `preamble`) — shown in the
   *  panel so the user can SEE what rides along with every ask. */
  readonly preamble: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathGet(value: unknown, path: string): unknown {
  let cursor: unknown = value;
  for (const key of path.split('.')) {
    if (Array.isArray(cursor)) {
      const index = Number(key);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
    } else if (isRecord(cursor)) {
      cursor = cursor[key];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function rowPayload(row: unknown): Record<string, unknown> | null {
  const payload = isRecord(row) && 'payload' in row ? (row as { payload: unknown }).payload : row;
  return isRecord(payload) ? payload : null;
}

/** Resolve one ref annotation: the option's `from_path` names a ref value; find the record of
 *  `kind` whose id equals that ref and return ITS label. Absent record → the ref's own tail
 *  segment (the ref value is real DATA the option carries — shown as-is, never invented). */
function resolveRefAnnotation(
  payload: Record<string, unknown>,
  annotation: Record<string, unknown>,
  rows: unknown[],
): string | null {
  const fromPath = typeof annotation.from_path === 'string' ? annotation.from_path : null;
  const kind = typeof annotation.kind === 'string' ? annotation.kind : null;
  if (!fromPath || !kind) return null;
  const ref = pathGet(payload, fromPath);
  if (typeof ref !== 'string' || ref.length === 0) return null;
  const labelPath = typeof annotation.label_path === 'string' ? annotation.label_path : 'label';
  for (const row of rows) {
    const candidate = rowPayload(row);
    if (!candidate || candidate.kind !== kind) continue;
    if (candidate.id !== ref) continue;
    const label = pathGet(candidate, labelPath);
    if (typeof label === 'string' && label.length > 0) return label;
  }
  const tail = ref.split(':').pop() ?? '';
  return tail.length > 0 ? tail : null;
}

/** Set a dot-path on a record, creating intermediate records along the way —
 *  the write-side mirror of pathGet (array indices are read-only here: a
 *  preamble value_path addresses record fields, not list positions). */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (!isRecord(cursor[key])) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]] = value;
}

/** Resolve the writing-instructions preamble from the live feed when the config names a
 *  `preamble_source: { kind, value_path }` record (edits to that record show up live);
 *  else fall back to a literal `preamble` string on the config. Exported: the dispatch
 *  rail resolves the LIVE preamble into the template's config.preamble binding at ask
 *  time, so a just-saved instruction rides the very next ask. */
export function resolvePreamble(config: Record<string, unknown>, rows: unknown[]): string | null {
  const source = isRecord(config.preamble_source) ? config.preamble_source : null;
  const kind = source && typeof source.kind === 'string' ? source.kind : null;
  if (kind) {
    const valuePath = typeof source!.value_path === 'string' ? (source!.value_path as string) : 'text';
    for (const row of rows) {
      const payload = rowPayload(row);
      if (!payload || payload.kind !== kind) continue;
      const text = pathGet(payload, valuePath);
      if (typeof text === 'string' && text.trim().length > 0) return text;
    }
  }
  return typeof config.preamble === 'string' && config.preamble.trim().length > 0 ? config.preamble : null;
}

/** Fold the config's `options` descriptor over the live published-record rows:
 *  `{ kind, label_path, value_path, description_path?, order_path?, exclude?, ref_annotations? }`.
 *  A bag with a title and an editable preamble (`edit`) but no `options` is a panel of just those instructions.
 *  title / label_path / value_path are REQUIRED DATA (F5): a config bag is authored
 *  intent, and hidden 'label'/'id'/'Settings' defaults let a half-authored bag
 *  silently guess another package's schema — absent → no view (the chevron honestly
 *  does not exist), never a guessed catalog. Ordering is DATA too: rows sort by
 *  `order_path` when the config declares one; otherwise the FEED order stands
 *  (the records' own order is the owner's order — an alphabetical default was the
 *  surface imposing an ordering nobody asked for). */
export function composerConfigView(
  config: Record<string, unknown> | undefined,
  publishedRows: unknown,
): ComposerConfigView | null {
  if (!config) return null;
  const title = typeof config.title === 'string' && config.title.trim() !== '' ? config.title : null;
  const optionsDef = isRecord(config.options) ? config.options : null;
  const kind = optionsDef && typeof optionsDef.kind === 'string' ? optionsDef.kind : null;
  const labelPath = optionsDef && typeof optionsDef.label_path === 'string' ? optionsDef.label_path : null;
  const valuePath = optionsDef && typeof optionsDef.value_path === 'string' ? optionsDef.value_path : null;
  if (!title) return null;
  const rows = Array.isArray(publishedRows) ? publishedRows : [];
  // A bag with no choices but an editable preamble (`edit`) is still a panel: the instructions every ask carries.
  if (!kind || !labelPath || !valuePath) return isRecord(config.edit) ? { title, options: [], defaultOption: null, preamble: resolvePreamble(config, rows) } : null;
  const descriptionPath = optionsDef && typeof optionsDef.description_path === 'string' ? optionsDef.description_path : null;
  const orderPath = optionsDef && typeof optionsDef.order_path === 'string' ? optionsDef.order_path : null;
  const excludes = optionsDef && Array.isArray(optionsDef.exclude) ? optionsDef.exclude.filter(isRecord) : [];
  const refAnnotations = optionsDef && Array.isArray(optionsDef.ref_annotations)
    ? optionsDef.ref_annotations.filter(isRecord) : [];
  const seen = new Set<string>();
  const options: ComposerConfigOption[] = [];
  for (const row of rows) {
    const payload = rowPayload(row);
    if (!payload || payload.kind !== kind) continue;
    if (excludes.some((e) => typeof e.path === 'string' && pathGet(payload, e.path) === e.equals)) continue;
    const value = pathGet(payload, valuePath);
    if (typeof value !== 'string' || value.length === 0) continue;
    // No human label at the declared path → not part of the human catalog (L118:
    // machine ids never render as product copy). Skipped, not id-fallbacked.
    const label = pathGet(payload, labelPath);
    if (typeof label !== 'string' || label.length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    const description = descriptionPath ? pathGet(payload, descriptionPath) : undefined;
    let annotation: string | null = null;
    for (const a of refAnnotations) {
      annotation = resolveRefAnnotation(payload, a, rows);
      if (annotation) break;
    }
    options.push({
      value,
      label,
      ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
      ...(annotation ? { annotation } : {}),
    });
  }
  if (orderPath) {
    const keyed = options.map((o, i) => {
      const row = rows.find((r) => {
        const p = rowPayload(r);
        return p && p.kind === kind && pathGet(p, valuePath) === o.value;
      });
      const key = row ? pathGet(rowPayload(row), orderPath) : undefined;
      return { o, i, key: typeof key === 'string' ? key : typeof key === 'number' ? key : null };
    });
    keyed.sort((a, b) => {
      if (a.key == null || b.key == null) return a.key == null ? (b.key == null ? a.i - b.i : 1) : -1;
      if (typeof a.key === 'number' && typeof b.key === 'number') return a.key - b.key || a.i - b.i;
      return String(a.key).localeCompare(String(b.key)) || a.i - b.i;
    });
    options.length = 0;
    options.push(...keyed.map((k) => k.o));
  }
  const defaultDef = isRecord(config.default_option) ? config.default_option : null;
  const defaultOption = defaultDef && typeof defaultDef.label === 'string'
    ? { value: typeof defaultDef.value === 'string' ? defaultDef.value : '', label: defaultDef.label }
    : null;
  return {
    title,
    options,
    defaultOption,
    preamble: resolvePreamble(config, rows),
  };
}

/** One disclosure-panel GROUP. The config bag itself is group '' (the sticky,
 *  select-dispatching choice — e.g. the agent); any nested key whose value is
 *  itself a config-shaped bag (title + options.kind — self-describing by SHAPE,
 *  never by name, L090) is a further group. `hasSelect` decides the semantics
 *  generically: a group WITH `select` dispatches a global write when chosen
 *  (sticky SSOT choice); a group WITHOUT `select` is a PER-ASK local choice the
 *  surface collects into the dispatch ctx's `config_selection` bag under the
 *  group's key. So "Model" (per-ask, no global state — the sticky default IS
 *  the agent profile) and "AI agent" (sticky) are the SAME anatomy with one
 *  DATA difference. */
export interface ComposerConfigGroup {
  readonly key: string;
  readonly view: ComposerConfigView;
  readonly hasSelect: boolean;
  /** DATA recipe resolving the group's implicit default from ANOTHER record
   *  (e.g. the selected agent's model_refs.0 mapped into the options): see
   *  resolveConfigDefaultFrom. Null = no derived default. */
  readonly defaultFrom: Record<string, unknown> | null;
}

/** Fold EVERY group the config bag carries (the bag itself + shape-matching
 *  nested bags, in key order). Groups whose view fails the required-DATA gate
 *  (missing title/label_path/value_path) simply don't exist. */
export function composerConfigGroups(
  config: Record<string, unknown> | undefined,
  publishedRows: unknown,
): ComposerConfigGroup[] {
  if (!config) return [];
  const groups: ComposerConfigGroup[] = [];
  const push = (key: string, bag: Record<string, unknown>) => {
    const view = composerConfigView(bag, publishedRows);
    if (!view) return;
    groups.push({
      key,
      view,
      hasSelect: isRecord(bag.select),
      defaultFrom: isRecord(bag.default_from) ? bag.default_from : null,
    });
  };
  push('', config);
  for (const [key, value] of Object.entries(config)) {
    if (!isRecord(value)) continue;
    if (typeof value.title === 'string' && isRecord(value.options) && typeof (value.options as Record<string, unknown>).kind === 'string') {
      push(key, value);
    }
  }
  return groups;
}

/** Resolve a group's derived default value from DATA:
 *  `default_from: { kind, current:{…ask}, ref_path, map:{ kind, by_path, value_path } }`
 *  — run the embedded ask (e.g. the selected-agent pointer), find the `kind`
 *  record with that id, read the ref at `ref_path` (e.g. model_refs.0), find
 *  the `map.kind` record whose `map.by_path` equals that ref, and return its
 *  `map.value_path` (e.g. the option's model id). Every hop is DATA; the
 *  resolver names nothing. Null anywhere → null (the panel marks the group's
 *  own default row instead — honest, never invented). */
export async function resolveConfigDefaultFrom(
  defaultFrom: Record<string, unknown>,
  publishedRows: unknown,
  sender: ComposerConfigSender = sendRequestToBitfieldTarget as ComposerConfigSender,
): Promise<string | null> {
  const kind = typeof defaultFrom.kind === 'string' ? defaultFrom.kind : null;
  const refPath = typeof defaultFrom.ref_path === 'string' ? defaultFrom.ref_path : null;
  const map = isRecord(defaultFrom.map) ? defaultFrom.map : null;
  if (!kind || !refPath || !map) return null;
  const currentId = await readComposerConfigCurrent({ current: defaultFrom.current } as Record<string, unknown>, sender);
  if (!currentId) return null;
  const rows = Array.isArray(publishedRows) ? publishedRows : [];
  let holder: Record<string, unknown> | null = null;
  for (const row of rows) {
    const payload = rowPayload(row);
    if (payload && payload.kind === kind && payload.id === currentId) { holder = payload; break; }
  }
  if (!holder) return null;
  const ref = pathGet(holder, refPath);
  if (typeof ref !== 'string' || !ref) return null;
  const mapKind = typeof map.kind === 'string' ? map.kind : null;
  const byPath = typeof map.by_path === 'string' ? map.by_path : null;
  const valuePath = typeof map.value_path === 'string' ? map.value_path : null;
  if (!mapKind || !byPath || !valuePath) return null;
  for (const row of rows) {
    const payload = rowPayload(row);
    if (!payload || payload.kind !== mapKind) continue;
    if (pathGet(payload, byPath) !== ref) continue;
    const value = pathGet(payload, valuePath);
    return typeof value === 'string' && value ? value : null;
  }
  return null;
}

/** Read the CURRENT choice via the config's DATA-declared ask
 *  (`current: { ask_target, ask_payload, value_path, parse? }`). Returns null when
 *  nothing is selected or the read fails — the panel simply marks no row. */
export async function readComposerConfigCurrent(
  config: Record<string, unknown> | undefined,
  sender: ComposerConfigSender = sendRequestToBitfieldTarget as ComposerConfigSender,
): Promise<string | null> {
  const current = config && isRecord(config.current) ? config.current : null;
  const target = current && typeof current.ask_target === 'string' ? current.ask_target : null;
  if (!current || !target || current.ask_payload === undefined) return null;
  try {
    const reply = await sender({ target, payload: current.ask_payload });
    let body: unknown = reply;
    const payload = isRecord(reply) ? (reply as { payload?: unknown }).payload : undefined;
    // ArrayBuffer.isView, not `instanceof Uint8Array`: reply bytes may come from another
    // realm (worker, VM, test env) whose Uint8Array constructor is a different identity.
    if (ArrayBuffer.isView(payload)) {
      const view = payload as ArrayBufferView;
      body = JSON.parse(new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)));
    } else if (typeof payload === 'string') body = JSON.parse(payload);
    else if (payload !== undefined) body = payload;
    const path = typeof current.value_path === 'string' ? current.value_path : 'items.0.value_json';
    let value = pathGet(body, path);
    if (current.parse === 'json' && typeof value === 'string') {
      try { value = JSON.parse(value); } catch { /* raw string is the value */ }
    }
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Dispatch the config's select action for a chosen option — the payload template
 *  resolves against `{ option: { value, label } }` via the SAME shared binding
 *  resolver the action rail uses. Returns true when a dispatch was actually sent. */
export async function dispatchComposerConfigSelect(
  config: Record<string, unknown> | undefined,
  option: ComposerConfigOption,
  sender: ComposerConfigSender = sendRequestToBitfieldTarget as ComposerConfigSender,
): Promise<boolean> {
  const select = config && isRecord(config.select) ? config.select : null;
  const target = select && typeof select.target === 'string' ? select.target : null;
  if (!select || !target) return false;
  const payload = select.payload_template !== undefined
    ? resolveBindingTemplate(select.payload_template, { option: { value: option.value, label: option.label } } as never)
    : {};
  await sender({ target, payload });
  return true;
}

/** Save an edited writing-instructions preamble to its OWN dedicated record via
 *  engine.operation.write-batch (the post-log-ownership front door). The config's
 *  `edit.record_address` names the DEDICATED preamble record — the SAME record
 *  `preamble_source: { kind, value_path }` reads — so the write touches ONLY the
 *  instruction text. The old path rewrote the WHOLE input-shortcut registry record
 *  from a possibly-stale feed row (F6: a concurrent rules[] edit — another surface
 *  adding a shortcut — was silently clobbered by the resurrected stale copy). A
 *  single-purpose record has no unrelated fields to clobber; concurrent saves of
 *  the SAME field are last-writer-wins on exactly that field, which is the honest
 *  semantic for one instruction text. Missing feed row → a fresh `{ kind }` payload
 *  (the record may not exist yet); throws on a rejected write. */
export async function writeComposerPreambleLive(
  config: Record<string, unknown> | undefined,
  newPreamble: string,
  publishedRows: unknown,
  partitionLabel: string,
  sender: ComposerConfigSender = sendRequestToBitfieldTarget as ComposerConfigSender,
): Promise<boolean> {
  const edit = config && isRecord(config.edit) ? config.edit : null;
  const recordAddress = edit && typeof edit.record_address === 'string' ? edit.record_address : null;
  const source = config && isRecord(config.preamble_source) ? config.preamble_source : null;
  const kind = source && typeof source.kind === 'string' ? source.kind : null;
  const valuePath = source && typeof source.value_path === 'string' ? source.value_path : null;
  if (!recordAddress || !partitionLabel || !kind || !valuePath) return false;
  const rows = Array.isArray(publishedRows) ? publishedRows : [];
  const row = rows.find((r) => isRecord(r) && (r as Record<string, unknown>).address === recordAddress);
  const payload = row ? rowPayload(row) : null;
  const next = payload && payload.kind === kind
    ? (JSON.parse(JSON.stringify(payload)) as Record<string, unknown>)
    : { kind };
  setPath(next, valuePath, newPreamble);
  const request = buildEngineWriteBatchRequestFromLabels([{
    partitionLabel,
    addressLabel: recordAddress,
    pathLabels: ['current-item', 'published-record'],
    payloadBytes: new TextEncoder().encode(JSON.stringify(next)),
  }]) as { target: string; payload: unknown };
  await sender(request);
  return true;
}
