// Deterministic projection from visible Visual Database cells to owner binding
// aliases. Durable identity remains recordRef + fieldRef; aliases are revisioned
// human/catalog DATA.

import {
  extractFieldValue,
  recordIdentityKey,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseModel,
} from '../read-data/visual-database';
import type { VisualDatabaseExpressionSelectionPolicy } from '../read-data/visual-database';

export interface ExpressionReferenceCandidate {
  id: string;
  displayAlias: string;
  bindingKey: string;
  insertionText: string;
  recordRef: string;
  fieldRef: string;
  value: unknown;
  valueType: string;
  /** Deterministic revision of the exact value exposed to an evaluator. */
  valueRevision: string;
}

export interface ExpressionReferenceCatalog {
  candidates: readonly ExpressionReferenceCandidate[];
  byBindingKey: ReadonlyMap<string, readonly ExpressionReferenceCandidate[]>;
  revision: string;
}

export interface MappedExpressionVariableRead {
  bindingKey: string;
  rootName: string;
  catalogId: string;
  recordRef: string;
  fieldRef: string;
  contextKey: string;
  valueRevision: string;
  span: { startUtf16: number; endUtf16: number } | null;
}

export interface MappedExpressionEvaluationReads {
  variables: readonly MappedExpressionVariableRead[];
  entities: readonly string[];
  specials: readonly string[];
  functions: readonly string[];
}

export interface ExpressionReadMappingIssue {
  code: 'missing-root' | 'ambiguous-root' | 'malformed-read';
  bindingKey?: string;
  rowIndex: number;
  span?: { startUtf16: number; endUtf16: number };
}

const STRUCTURAL_COLUMN_ROLES = new Set(['id', 'sort', 'link', 'kind']);

export function expressionReferenceColumns(
  model: VisualDatabaseModel,
): readonly VisualDatabaseFieldDescriptor[] {
  return model.fields.filter((descriptor) => !STRUCTURAL_COLUMN_ROLES.has(descriptor.role));
}

export function normalizeExpressionIdentifier(value: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const nonEmpty = normalized || '_';
  return /^[0-9]/.test(nonEmpty) ? `_${nonEmpty}` : nonEmpty;
}

function columnLetters(index: number): string {
  let value = index + 1;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function cellAlias(rowIndex: number, columnIndex: number): string {
  return `${columnLetters(columnIndex)}${rowIndex + 1}`;
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return '"$undefined"';
  if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A small deterministic content revision is sufficient here: identity and
 * authorization remain the addressed record/field refs, while this value only
 * proves whether the exact evaluator input changed. */
export function expressionReferenceValueRevision(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `value-fnv1a64-${hash.toString(16).padStart(16, '0')}`;
}

function candidateId(recordRef: string, fieldRef: string): string {
  return `cell::${encodeURIComponent(recordRef)}::${encodeURIComponent(fieldRef)}`;
}

export function expressionReferenceCatalogRevision(
  model: VisualDatabaseModel,
  columns: readonly VisualDatabaseFieldDescriptor[] = expressionReferenceColumns(model),
  currentRecordRef?: string,
): string {
  return JSON.stringify([
    currentRecordRef ?? null,
    model.records.map((record, order) => [recordIdentityKey(record), order]),
    columns.map((field, order) => [field.id, field.label, order]),
  ]);
}

/** Stable record order then visible column order is the sole alias-allocation
 * order. Current-row fields receive readable aliases; arbitrary cells receive
 * A1-style aliases. Deterministic suffixes make every binding key injective. */
export function buildExpressionReferenceCatalog(
  model: VisualDatabaseModel,
  options: {
    currentRecordRef?: string;
    columns?: readonly VisualDatabaseFieldDescriptor[];
  } = {},
): ExpressionReferenceCatalog {
  const columns = options.columns ?? expressionReferenceColumns(model);
  const allocated = new Map<string, number>();
  const candidates: ExpressionReferenceCandidate[] = [];
  for (let rowIndex = 0; rowIndex < model.records.length; rowIndex += 1) {
    const record = model.records[rowIndex]!;
    const recordRef = recordIdentityKey(record);
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const field = columns[columnIndex]!;
      const displayAlias = recordRef === options.currentRecordRef
        ? field.label
        : cellAlias(rowIndex, columnIndex);
      const base = normalizeExpressionIdentifier(displayAlias);
      const occurrence = (allocated.get(base) ?? 0) + 1;
      allocated.set(base, occurrence);
      const bindingKey = occurrence === 1 ? base : `${base}__${occurrence}`;
      const value = extractFieldValue(record, field);
      candidates.push({
        id: candidateId(recordRef, field.id),
        displayAlias,
        bindingKey,
        insertionText: bindingKey,
        recordRef,
        fieldRef: field.id,
        value,
        valueType: valueType(value),
        valueRevision: expressionReferenceValueRevision(value),
      });
    }
  }
  const byBindingKey = new Map<string, ExpressionReferenceCandidate[]>();
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new Error('Expression reference catalog contains duplicate cell identities.');
  }
  for (const candidate of candidates) {
    const rows = byBindingKey.get(candidate.bindingKey) ?? [];
    rows.push(candidate);
    byBindingKey.set(candidate.bindingKey, rows);
  }
  return {
    candidates,
    byBindingKey,
    revision: expressionReferenceCatalogRevision(model, columns, options.currentRecordRef),
  };
}

/** Validate externally supplied owner catalogs through the same injectivity
 * predicate used for source dependency mapping. */
export function indexExpressionReferences(
  candidates: readonly ExpressionReferenceCandidate[],
): ReadonlyMap<string, readonly ExpressionReferenceCandidate[]> {
  const index = new Map<string, ExpressionReferenceCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.id || !candidate.bindingKey || !candidate.recordRef || !candidate.fieldRef) {
      throw new Error('Expression reference candidate is missing stable identity.');
    }
    const rows = index.get(candidate.bindingKey) ?? [];
    rows.push(candidate);
    index.set(candidate.bindingKey, rows);
  }
  const collision = [...index.entries()].find(([, rows]) => rows.length !== 1);
  if (collision) throw new Error(`Expression reference alias ${collision[0]} is ambiguous.`);
  return index;
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readSpan(value: unknown): { startUtf16: number; endUtf16: number } | undefined {
  if (!recordValue(value)) return undefined;
  const start = value.start_utf16 ?? value.startUtf16;
  const end = value.end_utf16 ?? value.endUtf16;
  return Number.isInteger(start) && Number.isInteger(end) && (start as number) >= 0 && (end as number) >= (start as number)
    ? { startUtf16: start as number, endUtf16: end as number }
    : undefined;
}

function sortedUniqueStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && !!entry))].sort()
    : [];
}

/** Maps owner read rows to durable addressed dependencies only through the
 * current catalog. Missing and colliding aliases are explicit blocking
 * results; they never select an arbitrary cell or throw past the editor. */
export function mapExpressionEvaluationReads(
  value: unknown,
  catalog?: Pick<ExpressionReferenceCatalog, 'candidates'>,
): { reads: MappedExpressionEvaluationReads; issues: readonly ExpressionReadMappingIssue[] } {
  const candidatesByKey = new Map<string, ExpressionReferenceCandidate[]>();
  for (const candidate of catalog?.candidates ?? []) {
    const rows = candidatesByKey.get(candidate.bindingKey) ?? [];
    rows.push(candidate);
    candidatesByKey.set(candidate.bindingKey, rows);
  }
  const rawVariables = recordValue(value) && Array.isArray(value.variables) ? value.variables : [];
  const issues: ExpressionReadMappingIssue[] = [];
  const variables = rawVariables.flatMap((entry, rowIndex) => {
    if (!recordValue(entry)) {
      issues.push({ code: 'malformed-read', rowIndex });
      return [];
    }
    const bindingKey = readString(entry.binding_key ?? entry.bindingKey);
    const rootName = readString(entry.root_name ?? entry.rootName);
    const span = readSpan(entry.span);
    const malformedSpan = entry.span !== null && entry.span !== undefined && !span;
    if (!bindingKey || !rootName || malformedSpan) {
      issues.push({ code: 'malformed-read', rowIndex, ...(span ? { span } : {}) });
      return [];
    }
    const candidates = candidatesByKey.get(bindingKey) ?? [];
    if (candidates.length !== 1) {
      issues.push({
        code: candidates.length === 0 ? 'missing-root' : 'ambiguous-root',
        bindingKey,
        rowIndex,
        ...(span ? { span } : {}),
      });
      return [];
    }
    const candidate = candidates[0]!;
    return [{
      bindingKey,
      rootName,
      catalogId: candidate.id,
      recordRef: candidate.recordRef,
      fieldRef: candidate.fieldRef,
      contextKey: candidate.bindingKey,
      valueRevision: candidate.valueRevision,
      span: span ?? null,
    }];
  });
  return {
    reads: {
      variables,
      entities: recordValue(value) ? sortedUniqueStrings(value.entities) : [],
      specials: recordValue(value) ? sortedUniqueStrings(value.specials) : [],
      functions: recordValue(value) ? sortedUniqueStrings(value.functions) : [],
    },
    issues,
  };
}

export function formatExpressionReferenceSelection(
  candidates: readonly ExpressionReferenceCandidate[],
  policy: VisualDatabaseExpressionSelectionPolicy,
): string {
  if (policy.serialization !== 'explicit-list') {
    throw new Error('Expression reference selection policy is unsupported.');
  }
  const selected = policy.deduplicate
    ? candidates.filter((candidate, index) => candidates.findIndex((row) => row.id === candidate.id) === index)
    : [...candidates];
  indexExpressionReferences(selected);
  return selected.map((candidate) => candidate.insertionText).join(policy.separator);
}
