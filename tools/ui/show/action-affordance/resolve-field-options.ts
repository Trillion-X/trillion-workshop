// packages/ui/show/action-affordance/resolve-field-options.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// ONE blind resolver for "where do this field's options come from" — the
// options-source descriptor grammar. Before this module, hosts answered that
// question three different ways: a generic by-kind fold (duplicated in two
// panels), plus per-host SENTINEL branches (`options_address === '__export-formats'`,
// `=== 'task'`) each backed by a bespoke reader module. The sentinels were the
// violation (F7 / enum-dissolution): the host enumerated WHICH pools exist.
//
// The dissolution: every pool shape is a CONFIGURATION of one `options_source`
// descriptor the field row carries as DATA:
//
//   • records of a kind        → { kind, label_path?/label_paths?, value_path?, filter? }
//   • entries of a field       → { kind, prefer_id?, entries_path } — unfold a
//     map/array field of ONE matched record into options (an export-format map,
//     a palette map, a locale list — never coded for individually)
//   • titled feed records      → { titled:true, label_paths?, value_from:'address',
//     carry_record?, exclude_address_prefixes? } — any record a human named is
//     pickable; the value is its log address; the full record can ride along
//     for consumers that append onto the entity.
//
// The legacy `options_address` (a record KIND string) keeps working as the
// shorthand for the first shape — live rows (e.g. image-gen's
// ai-model-descriptor + options_filter) are untouched. Inline `options` stay
// the static fallback. The resolver never names a kind, an address, or a pool.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO pool names in code — every selection rule is descriptor DATA (L090).
// 2. Adding a new pool shape to a product = writing a descriptor row, not a
//    branch here. If a shape truly cannot be expressed, extend the GRAMMAR
//    (one generic property), never add a sentinel.
// 3. Labels are human copy: machine-id-only rows are skipped when the
//    descriptor declares label paths without fallback-to-value (titled pools),
//    and whitespace collapses to one line (labels are one-line by definition).
// 4. Fail-closed: no matching records ⇒ [] (callers fall back to inline
//    options or render an honest empty picker) — never an invented option.
// =============================================================================

import type { AskField, AskFieldOption } from './action-affordance-types';
import { getPath } from './read-action-affordances';

/** The minimal record shape the resolver folds — the host maps its feed rows
 *  (PublishedRecord, raw rows, …) into this. `address` is the record's log
 *  address when known (needed only by `value_from:'address'` pools). */
export interface OptionSourceRecord {
  readonly address?: string;
  readonly payload: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/** Labels are one-line human copy — collapse whitespace, clamp for pick rows. */
function oneLineLabel(raw: string, maxChars: number): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}

/** 'markdown' → 'Markdown', 'plain-text' → 'Plain Text' — the label for a map
 *  entry whose value carries no label of its own. Pure key humanization. */
function humanizeKey(key: string): string {
  const words = key.split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return key;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function firstTextAt(payload: Record<string, unknown>, paths: readonly string[]): string | null {
  for (const path of paths) {
    const v = asText(getPath(payload, path));
    if (v) return v;
  }
  return null;
}

/** The descriptor's capability filter — keep records whose value at `path`
 *  includes / equals the declared needle (same semantics options_filter always had). */
function passesFilter(
  payload: Record<string, unknown>,
  filter: { readonly path: string; readonly includes?: string; readonly equals?: unknown } | undefined,
): boolean {
  if (!filter) return true;
  const at = getPath(payload, filter.path);
  if (filter.includes !== undefined) {
    return Array.isArray(at) ? at.includes(filter.includes) : typeof at === 'string' && at.includes(filter.includes);
  }
  if (filter.equals !== undefined) return at === filter.equals;
  return true;
}

const DEFAULT_TITLE_PATHS = ['title', 'label', 'name'] as const;
const DEFAULT_LABEL_MAX = 80;

/** Unfold ONE matched record's map/array field into options (`entries_path`).
 *  Map: value = entry key, label = entry's own label (label_path within the
 *  entry) else the humanized key. Array: value/label at the declared paths. */
function entriesOptions(
  source: Record<string, unknown>,
  records: readonly OptionSourceRecord[],
): AskFieldOption[] {
  const kind = asText(source.kind);
  const entriesPath = asText(source.entries_path);
  if (!kind || !entriesPath) return [];
  const preferId = asText(source.prefer_id);
  let holder: Record<string, unknown> | null = null;
  for (const record of records) {
    if (record.payload.kind !== kind) continue;
    if (preferId && record.payload.id === preferId) { holder = record.payload; break; }
    if (!holder) holder = record.payload;
  }
  if (!holder) return [];
  const entries = getPath(holder, entriesPath);
  const labelPath = asText(source.label_path) ?? 'label';
  const valuePath = asText(source.value_path);
  const options: AskFieldOption[] = [];
  if (isRecord(entries)) {
    for (const [key, entry] of Object.entries(entries)) {
      // The entry's own label (at label_path, default 'label') wins; a label-less
      // entry falls back to its humanized key — the key IS the value either way.
      const label = (isRecord(entry) ? asText(getPath(entry, labelPath)) : null) ?? humanizeKey(key);
      options.push({ value: key, label });
    }
  } else if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const value = valuePath ? asText(getPath(entry, valuePath)) : asText(entry.id);
      if (!value) continue;
      const label = (labelPath ? asText(getPath(entry, labelPath)) : asText(entry.label)) ?? value;
      options.push({ value, label });
    }
  }
  return options;
}

/** The titled-feed entity pool: every record a human named (a non-empty string
 *  at one of the title paths) is pickable. Value = the record's address (the
 *  stable entity ref); the full record rides along when `carry_record` so a
 *  consumer can append onto the entity without a second read. */
function titledOptions(
  source: Record<string, unknown>,
  records: readonly OptionSourceRecord[],
): AskFieldOption[] {
  const labelPaths = Array.isArray(source.label_paths)
    ? source.label_paths.filter((p): p is string => typeof p === 'string')
    : DEFAULT_TITLE_PATHS;
  const excludePrefixes = Array.isArray(source.exclude_address_prefixes)
    ? source.exclude_address_prefixes.filter((p): p is string => typeof p === 'string')
    : [];
  const carry = source.carry_record === true;
  const maxChars = typeof source.label_max_chars === 'number' && source.label_max_chars > 0
    ? source.label_max_chars : DEFAULT_LABEL_MAX;
  const options: AskFieldOption[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const address = record.address ?? '';
    if (!address || seen.has(address)) continue;
    if (excludePrefixes.some((prefix) => address.startsWith(prefix))) continue;
    if (!passesFilter(record.payload, source.filter as { path: string; includes?: string; equals?: unknown } | undefined)) continue;
    const title = firstTextAt(record.payload, labelPaths);
    if (!title) continue;
    seen.add(address);
    options.push({
      value: address,
      label: oneLineLabel(title, maxChars),
      ...(carry ? { record: { address, payload: record.payload } } : {}),
    });
  }
  return options;
}

/** Records-of-a-kind pool (the shape `options_address` always meant). */
function kindOptions(
  kind: string,
  source: Record<string, unknown>,
  records: readonly OptionSourceRecord[],
): AskFieldOption[] {
  const labelPath = asText(source.label_path);
  const labelPaths = Array.isArray(source.label_paths)
    ? source.label_paths.filter((p): p is string => typeof p === 'string')
    : labelPath ? [labelPath] : ['display_name', 'label', 'name'];
  const valuePath = asText(source.value_path);
  const limit = typeof source.limit === 'number' && source.limit > 0 ? source.limit : Infinity;
  const carry = source.carry_record === true;
  const options: AskFieldOption[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const p = record.payload;
    if (p.kind !== kind) continue;
    if (!passesFilter(p, source.filter as { path: string; includes?: string; equals?: unknown } | undefined)) continue;
    const value = valuePath ? asText(getPath(p, valuePath)) : (asText(p.id) ?? asText(p.value));
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const label = firstTextAt(p, labelPaths) ?? value;
    options.push({
      value,
      label,
      ...(carry ? { record: { address: record.address, payload: p } } : {}),
    });
    if (seen.size >= limit) break;
  }
  return options;
}

/**
 * Resolve one field's options against the live feed. Precedence:
 *   1. `field.options_source` — the full descriptor grammar (titled / entries / records-of-kind);
 *   2. `field.options_address` — legacy shorthand: records of that KIND, with
 *      `field.options_filter` narrowing (unchanged semantics, zero live-row churn);
 *   3. `field.options` — inline static DATA choices.
 * Live pools that resolve empty fall through to inline options, so a row can
 * declare both a live source and a static fallback.
 */
export function resolveAskFieldOptions(
  field: AskField,
  records: readonly OptionSourceRecord[],
): AskFieldOption[] {
  const source = isRecord((field as { options_source?: unknown }).options_source)
    ? (field as { options_source: Record<string, unknown> }).options_source
    : null;
  if (source) {
    const live = source.titled === true
      ? titledOptions(source, records)
      : asText(source.entries_path)
        ? entriesOptions(source, records)
        : asText(source.kind)
          ? kindOptions(source.kind as string, source, records)
          : [];
    if (live.length) return live;
  } else if (typeof field.options_address === 'string' && field.options_address) {
    const live = kindOptions(
      field.options_address,
      { filter: field.options_filter } as Record<string, unknown>,
      records,
    );
    if (live.length) return live;
  }
  return field.options ? [...field.options] : [];
}
