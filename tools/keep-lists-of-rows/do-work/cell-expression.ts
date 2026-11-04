// Caller-ready assembly for an addressed value. EEAF owns generic type/property
// vocabulary; Visual Database translates independently addressed source, cache,
// and provenance values into one cell model for its consumers.

import type {
  VisualDatabaseCellRef,
  VisualDatabaseDependencyRef,
  VisualDatabaseFieldDescriptor,
  VisualDatabaseValueExpression,
} from '../read-data/visual-database';

export interface VisualDatabaseCellCache {
  value: unknown;
  revision?: string;
  sourceRevision?: string;
  observedAt?: string;
}

export interface VisualDatabaseCellProvenance {
  ref: string;
  revision?: string;
  sourceRevision?: string;
  evaluatorRef?: string;
  evaluatorTarget?: string;
  evaluatorRevision?: string;
  policyRevision?: string;
  displayLabel?: string;
  reads?: {
    variables: readonly {
      bindingKey: string;
      rootName: string;
      catalogId: string;
      recordRef: string;
      fieldRef: string;
      contextKey?: string;
      valueRevision: string;
      span: { startUtf16: number; endUtf16: number } | null;
    }[];
    entities: readonly string[];
    specials: readonly string[];
    functions: readonly string[];
  };
}

export interface AddressedCellValues {
  cellRef: VisualDatabaseCellRef;
  expression?: VisualDatabaseValueExpression;
  cachedValue?: VisualDatabaseCellCache;
  provenance?: VisualDatabaseCellProvenance;
  revision?: string;
  sourceExpectedCurrent?: { payloadHash: Uint8Array } | null;
  cacheExpectedCurrent?: { payloadHash: Uint8Array } | null;
  provenanceExpectedCurrent?: { payloadHash: Uint8Array } | null;
}

export interface MaterializedCellExpression extends AddressedCellValues {
  expression: VisualDatabaseValueExpression;
  source: 'cell' | 'field-default';
}

export interface CellExpressionIssue {
  code: 'both-sources' | 'no-source' | 'missing-evaluator' | 'invalid-dependency' | 'invalid-path' | 'malformed-source' | 'duplicate-revision';
  message: string;
}

const EMPTY_CELL_EXPRESSION_ISSUES: readonly CellExpressionIssue[] = Object.freeze([]);

export interface CellExpressionEvent {
  event: 'visual_database.cell_expression_written' | 'visual_database.field_default_applied';
  cell_ref: { record_ref: string; field_ref: string };
  source_shape?: 'literal' | 'derive';
  field_ref?: string;
  revision?: string;
}

/** The owner-facing record shape. Callers hand Visual Database complete addressed
 * values; this fold deliberately knows no EEAF property/fact representation. */
export interface AddressedCellValueRecord {
  revision?: string;
  /** Load-time CAS basis supplied by the owner read boundary. */
  expectedCurrent?: { payloadHash: Uint8Array } | null;
  payload: unknown;
}

export interface AddressedCellExpressionInputs {
  sources: readonly AddressedCellValueRecord[];
  caches: readonly AddressedCellValueRecord[];
  provenances: readonly AddressedCellValueRecord[];
}

function rowsFromPublishedInput(raw: unknown): readonly unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  for (const key of ['records', 'items', 'rows']) if (Array.isArray(raw[key])) return raw[key] as unknown[];
  return [];
}

function bytesFromBase64(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); } catch { return undefined; }
}

/** Partitions the existing published-record feed into T6's three caller-ready
 * addressed families. No new input or SSOT is introduced: these values already
 * share the board's owner feed and are excluded from human rows by that decoder. */
export function addressedCellInputsFromPublishedRecords(raw: unknown): AddressedCellExpressionInputs {
  const sources: AddressedCellValueRecord[] = [];
  const caches: AddressedCellValueRecord[] = [];
  const provenances: AddressedCellValueRecord[] = [];
  for (const row of rowsFromPublishedInput(raw)) {
    if (!isRecord(row)) continue;
    const payload = isRecord(row.payload) ? row.payload : null;
    if (!payload || !readRef(payload.cell_ref ?? payload.cellRef)) continue;
    const payloadHash = bytesFromBase64(row.payload_hash_base64 ?? row.payloadHashBase64);
    const payloadRevision = typeof payload.revision === 'string' && payload.revision.trim()
      ? payload.revision
      : undefined;
    const record = {
      payload,
      ...(payloadRevision
        ? { revision: payloadRevision }
        : typeof row.revision === 'string' ? { revision: row.revision } : {}),
      ...(payloadHash ? { expectedCurrent: { payloadHash } } : { expectedCurrent: null }),
    };
    if (hasOwn(payload, 'expression')) sources.push(record);
    else if (hasOwn(payload, 'cached_value') || hasOwn(payload, 'cachedValue')) caches.push(record);
    else if (hasOwn(payload, 'provenance_ref') || hasOwn(payload, 'provenanceRef')) provenances.push(record);
  }
  return { sources, caches, provenances };
}

export interface FoldedCellExpression {
  cellRef: VisualDatabaseCellRef;
  expression?: VisualDatabaseValueExpression;
  cachedValue?: VisualDatabaseCellCache;
  provenance?: VisualDatabaseCellProvenance;
  source: 'cell' | 'field-default' | 'invalid';
  cacheState?: 'current' | 'stale';
  /** Freshness of the independently stored cache + provenance pair relative
   * to the active source revision. Projection bytes remain available for
   * inspection, but only `current` may be presented as current evidence. */
  projectionState: 'current' | 'stale' | 'missing' | 'partial';
  sourceExpectedCurrent?: { payloadHash: Uint8Array } | null;
  cacheExpectedCurrent?: { payloadHash: Uint8Array } | null;
  provenanceExpectedCurrent?: { payloadHash: Uint8Array } | null;
  /** An explicit source record was present but cannot safely participate in
   * evaluation. This is distinct from cache/provenance projection defects:
   * only an invalid explicit source blocks the field default for that cell. */
  explicitSourceInvalid: boolean;
  issues: readonly CellExpressionIssue[];
}

export function cellRefKey(ref: VisualDatabaseCellRef): string {
  // A serialized tuple is injective; delimiter concatenation is not (for
  // example `a::b`/`c` and `a`/`b::c`). These are opaque addresses, so no
  // delimiter is reserved by the protocol.
  return JSON.stringify([ref.recordRef, ref.fieldRef]);
}

/** Materializes a field-default selector into canonical addressed edges for
 * one record. The selector is migration/template policy; the graph consumes
 * only dependencyRefs. */
export function materializeAddressedDependencies(
  expression: VisualDatabaseValueExpression,
  recordRef: string,
): VisualDatabaseValueExpression {
  const derive = expression.derive;
  if (!derive || (derive.dependencyRefs?.length ?? 0) > 0) return expression;
  const fields = derive.dependencySelector?.contextFromFields
    ?? derive.dependencySelector?.context_from_fields;
  if (!Array.isArray(fields) || !fields.every((field): field is string => typeof field === 'string' && !!field)) return expression;
  return {
    derive: {
      ...derive,
      dependencyRefs: fields.map((fieldRef) => ({ recordRef, fieldRef, contextKey: fieldRef })),
    },
  };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function expressionSourceShape(expression: VisualDatabaseValueExpression): 'literal' | 'derive' | null {
  const literal = hasOwn(expression, 'literal');
  const derive = hasOwn(expression, 'derive') && expression.derive !== undefined;
  return literal === derive ? null : literal ? 'literal' : 'derive';
}

/** Validates source truth only. A stale cache never invalidates source truth,
 * and a cross-table dependency is a valid addressed edge. */
export function validateCellExpression(expression: VisualDatabaseValueExpression | undefined): readonly CellExpressionIssue[] {
  if (!expression) return [{ code: 'no-source', message: 'A cell needs one literal or derive source.' }];
  const shape = expressionSourceShape(expression);
  if (!shape) {
    return [{
      code: hasOwn(expression, 'literal') && hasOwn(expression, 'derive') ? 'both-sources' : 'no-source',
      message: 'A cell must have exactly one literal or derive source.',
    }];
  }
  if (shape === 'literal') return EMPTY_CELL_EXPRESSION_ISSUES;
  const derive = expression.derive;
  if (!derive?.target.trim()) return [{ code: 'missing-evaluator', message: 'A derived cell needs an addressed evaluator target.' }];
  const dependencies = derive.dependencyRefs ?? [];
  const invalidDependency = dependencies.some((ref) => (
    !ref.recordRef.trim()
    || !ref.fieldRef.trim()
    || (ref.contextKey !== undefined && !ref.contextKey.trim())
  ));
  const uniqueDependencies = new Set(dependencies.map((ref) => JSON.stringify([
    ref.recordRef,
    ref.fieldRef,
    ref.contextKey ?? null,
  ])));
  if (invalidDependency || uniqueDependencies.size !== dependencies.length) {
    return [{ code: 'invalid-dependency', message: 'Every dependency must have one unique non-empty record, field, and optional context key.' }];
  }
  const invalidPath = [derive.resultPath, derive.cachePath]
    .filter((path): path is readonly string[] => path !== undefined)
    .some((path) => !validObjectPath(path));
  return invalidPath
    ? [{ code: 'invalid-path', message: 'Evaluator paths must contain one to 64 safe non-empty object keys.' }]
    : EMPTY_CELL_EXPRESSION_ISSUES;
}

/** Applies a field default only where explicit cell source truth is absent.
 * Cache/provenance pass through unchanged because projections never become a
 * literal source. */
export function materializeCellExpression(
  field: VisualDatabaseFieldDescriptor,
  values: AddressedCellValues,
): MaterializedCellExpression | { readonly issues: readonly CellExpressionIssue[] } {
  const expression = values.expression ?? field.defaultExpression;
  const issues = validateCellExpression(expression);
  if (issues.length > 0 || !expression) return { issues };
  return {
    ...values,
    expression,
    source: values.expression ? 'cell' : 'field-default',
  };
}

export function cellExpressionEvent(cell: MaterializedCellExpression): CellExpressionEvent {
  const shape = expressionSourceShape(cell.expression);
  const cell_ref = { record_ref: cell.cellRef.recordRef, field_ref: cell.cellRef.fieldRef };
  return cell.source === 'field-default'
    ? { event: 'visual_database.field_default_applied', cell_ref, field_ref: cell.cellRef.fieldRef }
    : {
      event: 'visual_database.cell_expression_written',
      cell_ref,
      source_shape: shape ?? 'literal',
      ...(cell.revision ? { revision: cell.revision } : {}),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const PATH_PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function validObjectPath(path: readonly string[]): boolean {
  return path.length > 0
    && path.length <= 64
    && path.every((segment) => (
      typeof segment === 'string'
      && segment.length > 0
      && segment.trim() === segment
      && !PATH_PROTOTYPE_KEYS.has(segment)
    ));
}

function readRef(value: unknown): VisualDatabaseCellRef | null {
  if (!isRecord(value)) return null;
  if (hasOwn(value, 'context_key') || hasOwn(value, 'contextKey')) return null;
  const recordRef = typeof value.record_ref === 'string' ? value.record_ref : value.recordRef;
  const fieldRef = typeof value.field_ref === 'string' ? value.field_ref : value.fieldRef;
  return typeof recordRef === 'string' && recordRef && typeof fieldRef === 'string' && fieldRef
    ? { recordRef, fieldRef }
    : null;
}

function readDependencyRef(value: unknown): VisualDatabaseDependencyRef | null {
  if (!isRecord(value)) return null;
  const recordRef = typeof value.record_ref === 'string' ? value.record_ref : value.recordRef;
  const fieldRef = typeof value.field_ref === 'string' ? value.field_ref : value.fieldRef;
  if (typeof recordRef !== 'string' || !recordRef || typeof fieldRef !== 'string' || !fieldRef) return null;
  const ref = { recordRef, fieldRef };
  const rawContextKey = value.context_key ?? value.contextKey;
  if (rawContextKey === undefined) return ref;
  return typeof rawContextKey === 'string' && rawContextKey.trim()
    ? { ...ref, contextKey: rawContextKey }
    : null;
}

type ParsedFact<T> = { ref: VisualDatabaseCellRef; revision?: string; expectedCurrent?: { payloadHash: Uint8Array } | null; value: T };

function newestByCell<T>(
  records: readonly AddressedCellValueRecord[],
  parse: (payload: unknown) => { ref: VisualDatabaseCellRef; value: T } | null,
): { values: ReadonlyMap<string, ParsedFact<T>>; malformed: ReadonlySet<string>; duplicates: ReadonlySet<string> } {
  const values = new Map<string, ParsedFact<T>>();
  const malformed = new Set<string>();
  const duplicates = new Set<string>();
  for (const record of records) {
    const parsed = parse(record.payload);
    if (!parsed) { malformed.add(JSON.stringify(record.payload)); continue; }
    const key = cellRefKey(parsed.ref);
    const prior = values.get(key);
    // Each addressed current-item value has one identity. Revision strings are
    // opaque and therefore cannot supply an ordering relation. Any second row
    // is a conflicting projection, regardless of its revision.
    if (prior) { duplicates.add(key); continue; }
    const fact: ParsedFact<T> = parsed;
    if (record.revision !== undefined) fact.revision = record.revision;
    if (record.expectedCurrent !== undefined) fact.expectedCurrent = record.expectedCurrent;
    values.set(key, fact);
  }
  return { values, malformed, duplicates };
}

function parseSource(payload: unknown): { ref: VisualDatabaseCellRef; value: VisualDatabaseValueExpression | undefined } | null {
  if (!isRecord(payload)) return null;
  const ref = readRef(payload.cell_ref ?? payload.cellRef);
  return ref ? {
    ref,
    value: normalizeExpression(payload.expression),
  } : null;
}

function normalizeExpression(value: unknown): VisualDatabaseValueExpression | undefined {
  if (!isRecord(value)) return undefined;
  if (hasOwn(value, 'literal') && !hasOwn(value, 'derive')) return { literal: value.literal };
  if (!isRecord(value.derive) || hasOwn(value, 'literal')) return undefined;
  const derive = value.derive;
  const rawDependencies = derive.dependency_refs ?? derive.dependencyRefs;
  const dependencyMemberPresent = hasOwn(derive, 'dependency_refs') || hasOwn(derive, 'dependencyRefs');
  if (dependencyMemberPresent && (!Array.isArray(rawDependencies) || rawDependencies.length > 10000
    || rawDependencies.some((dependency) => readDependencyRef(dependency) === null))) {
    return undefined;
  }
  const dependencyRefs = Array.isArray(rawDependencies)
    ? rawDependencies.map(readDependencyRef) as VisualDatabaseDependencyRef[]
    : [];
  if (new Set(dependencyRefs.map((dependency) => JSON.stringify([
    dependency.recordRef,
    dependency.fieldRef,
    dependency.contextKey ?? null,
  ]))).size !== dependencyRefs.length) return undefined;
  const rawResultPath = derive.result_path ?? derive.resultPath;
  const rawCachePath = derive.cache_path ?? derive.cachePath;
  if ((rawResultPath !== undefined && (!Array.isArray(rawResultPath) || !validObjectPath(rawResultPath as string[])))
    || (rawCachePath !== undefined && (!Array.isArray(rawCachePath) || !validObjectPath(rawCachePath as string[])))) {
    return undefined;
  }
  return {
    derive: {
      target: typeof derive.target === 'string' ? derive.target : '',
      ...(typeof (derive.evaluator_ref ?? derive.evaluatorRef) === 'string'
        ? { evaluatorRef: (derive.evaluator_ref ?? derive.evaluatorRef) as string }
        : {}),
      ...(isRecord(derive.request) ? { request: derive.request } : {}),
      ...(Array.isArray(rawResultPath) && rawResultPath.every((part) => typeof part === 'string')
        ? { resultPath: rawResultPath as string[] }
        : {}),
      ...(dependencyRefs.length > 0 ? { dependencyRefs } : {}),
      ...(isRecord(derive.dependency_selector ?? derive.dependencySelector)
        ? { dependencySelector: (derive.dependency_selector ?? derive.dependencySelector) as Record<string, unknown> }
        : {}),
      ...(Array.isArray(rawCachePath) && rawCachePath.every((part) => typeof part === 'string')
        ? { cachePath: rawCachePath as string[] }
        : {}),
      ...(typeof derive.persist === 'boolean' ? { persist: derive.persist } : {}),
    },
  };
}

function parseCache(payload: unknown): { ref: VisualDatabaseCellRef; value: VisualDatabaseCellCache } | null {
  if (!isRecord(payload)) return null;
  const ref = readRef(payload.cell_ref ?? payload.cellRef);
  const raw = payload.cached_value ?? payload.cachedValue;
  if (!ref || !isRecord(raw) || !hasOwn(raw, 'value')) return null;
  const sourceRevision = raw.source_revision ?? raw.sourceRevision;
  const observedAt = raw.observed_at ?? raw.observedAt;
  return {
    ref,
    value: {
      value: raw.value,
      ...(typeof raw.revision === 'string' ? { revision: raw.revision } : {}),
      ...(typeof sourceRevision === 'string' ? { sourceRevision } : {}),
      ...(typeof observedAt === 'string' ? { observedAt } : {}),
    },
  };
}

function parseProvenance(payload: unknown): { ref: VisualDatabaseCellRef; value: VisualDatabaseCellProvenance } | null {
  if (!isRecord(payload)) return null;
  const requiredKeys = [
    'cell_ref',
    'provenance_ref',
    'revision',
    'source_revision',
    'evaluator_ref',
    'evaluator_target',
    'evaluator_revision',
    'policy_revision',
    'reads',
    'provenance_display_label',
  ];
  if (Object.keys(payload).length !== requiredKeys.length || !requiredKeys.every((key) => hasOwn(payload, key))) return null;
  const ref = readRef(payload.cell_ref);
  const provenanceRef = payload.provenance_ref;
  const sourceRevision = payload.source_revision;
  const evaluatorRef = payload.evaluator_ref;
  const evaluatorTarget = payload.evaluator_target;
  const evaluatorRevision = payload.evaluator_revision;
  const policyRevision = payload.policy_revision;
  const displayLabel = payload.provenance_display_label;
  const reads = readProvenanceReads(payload.reads);
  return ref
    && [provenanceRef, payload.revision, sourceRevision, evaluatorRef, evaluatorTarget, evaluatorRevision, policyRevision, displayLabel]
      .every((value) => typeof value === 'string' && value.trim())
    && reads
    ? {
        ref,
        value: {
          ref: provenanceRef as string,
          revision: payload.revision as string,
          sourceRevision: sourceRevision as string,
          evaluatorRef: evaluatorRef as string,
          evaluatorTarget: evaluatorTarget as string,
          evaluatorRevision: evaluatorRevision as string,
          policyRevision: policyRevision as string,
          displayLabel: displayLabel as string,
          reads,
        },
      }
    : null;
}

const EMPTY_PROVENANCE_VALUES: readonly string[] = Object.freeze([]);
const EMPTY_PROVENANCE_READS: NonNullable<VisualDatabaseCellProvenance['reads']> = Object.freeze({
  variables: Object.freeze([]),
  entities: EMPTY_PROVENANCE_VALUES,
  specials: EMPTY_PROVENANCE_VALUES,
  functions: EMPTY_PROVENANCE_VALUES,
});

function readProvenanceReads(value: unknown): VisualDatabaseCellProvenance['reads'] | undefined {
  if (!isRecord(value)
    || Object.keys(value).length !== 4
    || !['variables', 'entities', 'specials', 'functions'].every((key) => hasOwn(value, key))) return undefined;
  // Empty readsets are the overwhelmingly common literal/cached projection
  // case. Preserve one immutable canonical value instead of allocating four
  // arrays plus four uniqueness sets for every folded cell.
  if (Array.isArray(value.variables) && value.variables.length === 0
    && Array.isArray(value.entities) && value.entities.length === 0
    && Array.isArray(value.specials) && value.specials.length === 0
    && Array.isArray(value.functions) && value.functions.length === 0) {
    return EMPTY_PROVENANCE_READS;
  }
  const strings = (entry: unknown): readonly string[] | null => (
    Array.isArray(entry)
      && entry.length <= 10_000
      && entry.every((item) => typeof item === 'string' && item.length > 0)
      && new Set(entry).size === entry.length
      ? entry as string[]
      : null
  );
  if (!Array.isArray(value.variables) || value.variables.length > 10_000) return undefined;
  const variables = value.variables.map((entry) => {
    if (!isRecord(entry)) return null;
    const required = ['binding_key', 'root_name', 'catalog_id', 'record_ref', 'field_ref', 'value_revision', 'span'];
    const allowed = [...required, 'context_key'];
    if (Object.keys(entry).some((key) => !allowed.includes(key)) || !required.every((key) => hasOwn(entry, key))) return null;
    const bindingKey = entry.binding_key;
    const rootName = entry.root_name;
    const catalogId = entry.catalog_id;
    const recordRef = entry.record_ref;
    const fieldRef = entry.field_ref;
    const valueRevision = entry.value_revision;
    const contextKey = entry.context_key;
    const rawSpan = entry.span;
    let span: { startUtf16: number; endUtf16: number } | null;
    if (rawSpan === null) {
      span = null;
    } else if (isRecord(rawSpan)) {
      if (Object.keys(rawSpan).length !== 2 || !hasOwn(rawSpan, 'start_utf16') || !hasOwn(rawSpan, 'end_utf16')) return null;
      const start = rawSpan.start_utf16;
      const end = rawSpan.end_utf16;
      if (!Number.isInteger(start) || !Number.isInteger(end) || (end as number) < (start as number)) return null;
      span = { startUtf16: start as number, endUtf16: end as number };
    } else {
      return null;
    }
    return [bindingKey, rootName, catalogId, recordRef, fieldRef, valueRevision].every((item) => typeof item === 'string' && item)
      && (contextKey === undefined || (typeof contextKey === 'string' && !!contextKey))
      ? {
          bindingKey: bindingKey as string,
          rootName: rootName as string,
          catalogId: catalogId as string,
          recordRef: recordRef as string,
          fieldRef: fieldRef as string,
          valueRevision: valueRevision as string,
          ...(typeof contextKey === 'string' ? { contextKey } : {}),
          span,
        }
      : null;
  });
  const entities = strings(value.entities);
  const specials = strings(value.specials);
  const functions = strings(value.functions);
  const variableKeys = variables.map((entry) => JSON.stringify(entry));
  return variables.every((entry) => entry !== null)
    && new Set(variableKeys).size === variableKeys.length
    && entities
    && specials
    && functions
    ? {
        variables: variables as NonNullable<VisualDatabaseCellProvenance['reads']>['variables'],
        entities,
        specials,
        functions,
      }
    : undefined;
}

/** The owner commonly publishes source, cache, and provenance as one aligned
 * current-state projection. Fold that complete topology in one pass instead of
 * materializing three maps plus a fourth union. Any absence, misalignment,
 * duplicate, malformed value, or invalid source falls through to the complete
 * conflict-preserving fold below. */
function foldAlignedCurrentProjections(
  fields: readonly VisualDatabaseFieldDescriptor[],
  inputs: AddressedCellExpressionInputs,
): readonly FoldedCellExpression[] | null {
  const count = inputs.sources.length;
  if (inputs.caches.length !== count || inputs.provenances.length !== count) return null;
  if (count === 0) return [];
  const fieldByRef = new Map(fields.map((field) => [field.id, field]));
  const seen = new Set<string>();
  const rows: { key: string; value: FoldedCellExpression }[] = [];
  for (let index = 0; index < count; index += 1) {
    const sourceRecord = inputs.sources[index]!;
    const cacheRecord = inputs.caches[index]!;
    const provenanceRecord = inputs.provenances[index]!;
    const source = parseSource(sourceRecord.payload);
    const cache = parseCache(cacheRecord.payload);
    const provenance = parseProvenance(provenanceRecord.payload);
    if (!source || !cache || !provenance
      || source.ref.recordRef !== cache.ref.recordRef
      || source.ref.fieldRef !== cache.ref.fieldRef
      || source.ref.recordRef !== provenance.ref.recordRef
      || source.ref.fieldRef !== provenance.ref.fieldRef
      || !source.value
      || !fieldByRef.has(source.ref.fieldRef)
      || validateCellExpression(source.value).length > 0) return null;
    const key = cellRefKey(source.ref);
    if (seen.has(key)) return null;
    seen.add(key);
    const cacheState = cache.value.sourceRevision && sourceRecord.revision
      && cache.value.sourceRevision !== sourceRecord.revision
      ? 'stale'
      : 'current';
    const projectionState = sourceRecord.revision
      && cache.value.sourceRevision === sourceRecord.revision
      && provenance.value.sourceRevision === sourceRecord.revision
      ? 'current'
      : 'stale';
    rows.push({
      key,
      value: foldedCellExpression({
        ref: source.ref,
        expression: source.value,
        cachedValue: cache.value,
        provenance: provenance.value,
        source: 'cell',
        cacheState,
        projectionState,
        hasSource: true,
        hasRawCache: true,
        hasRawProvenance: true,
        sourceExpectedCurrent: sourceRecord.expectedCurrent,
        cacheExpectedCurrent: cacheRecord.expectedCurrent,
        provenanceExpectedCurrent: provenanceRecord.expectedCurrent,
        explicitSourceInvalid: false,
        issues: EMPTY_CELL_EXPRESSION_ISSUES,
      }),
    });
  }
  rows.sort((left, right) => compareCellKeys(left.key, right.key));
  return rows.map((row) => row.value);
}

function compareCellKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function foldedCellExpression(input: {
  ref: VisualDatabaseCellRef;
  expression?: VisualDatabaseValueExpression;
  cachedValue?: VisualDatabaseCellCache;
  provenance?: VisualDatabaseCellProvenance;
  source: FoldedCellExpression['source'];
  cacheState?: FoldedCellExpression['cacheState'];
  projectionState: FoldedCellExpression['projectionState'];
  hasSource: boolean;
  hasRawCache: boolean;
  hasRawProvenance: boolean;
  sourceExpectedCurrent?: AddressedCellValueRecord['expectedCurrent'];
  cacheExpectedCurrent?: AddressedCellValueRecord['expectedCurrent'];
  provenanceExpectedCurrent?: AddressedCellValueRecord['expectedCurrent'];
  explicitSourceInvalid: boolean;
  issues: readonly CellExpressionIssue[];
}): FoldedCellExpression {
  return {
    cellRef: input.ref,
    ...(input.expression ? { expression: input.expression } : {}),
    ...(input.cachedValue ? { cachedValue: input.cachedValue } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
    source: input.source,
    ...(input.cacheState ? { cacheState: input.cacheState } : {}),
    projectionState: input.projectionState,
    ...(input.hasSource ? { sourceExpectedCurrent: input.sourceExpectedCurrent } : {}),
    ...(input.hasRawCache ? { cacheExpectedCurrent: input.cacheExpectedCurrent } : {}),
    ...(input.hasRawProvenance ? { provenanceExpectedCurrent: input.provenanceExpectedCurrent } : {}),
    explicitSourceInvalid: input.explicitSourceInvalid,
    issues: input.issues,
  };
}

/** The complete Visual Database read boundary. It folds independent addressed
 * values by cell ref, resolves field defaults, carries projections/provenance,
 * fails closed on duplicate source revisions, and reports stale cache without
 * ever converting it into source truth. */
export function foldAddressedCellExpressions(
  fields: readonly VisualDatabaseFieldDescriptor[],
  inputs: AddressedCellExpressionInputs,
): readonly FoldedCellExpression[] {
  const aligned = foldAlignedCurrentProjections(fields, inputs);
  if (aligned) return aligned;
  const sources = newestByCell(inputs.sources, parseSource);
  const caches = newestByCell(inputs.caches, parseCache);
  const provenances = newestByCell(inputs.provenances, parseProvenance);
  const fieldByRef = new Map(fields.map((field) => [field.id, field]));
  const keys = new Set(sources.values.keys());
  for (const key of caches.values.keys()) keys.add(key);
  for (const key of provenances.values.keys()) keys.add(key);
  return [...keys].sort(compareCellKeys).map((key) => {
    const source = sources.values.get(key);
    const rawCache = caches.values.get(key);
    const rawProvenance = provenances.values.get(key);
    const cache = caches.duplicates.has(key) ? undefined : rawCache;
    const provenance = provenances.duplicates.has(key) ? undefined : rawProvenance;
    const ref = source?.ref ?? rawCache?.ref ?? rawProvenance!.ref;
    let issues: CellExpressionIssue[] | undefined;
    if (sources.duplicates.has(key)) (issues ??= []).push({ code: 'duplicate-revision', message: 'More than one source has the same addressed cell identity.' });
    if (caches.duplicates.has(key)) (issues ??= []).push({ code: 'duplicate-revision', message: 'More than one cached projection has the same addressed cell identity.' });
    if (provenances.duplicates.has(key)) (issues ??= []).push({ code: 'duplicate-revision', message: 'More than one provenance value has the same addressed cell identity.' });
    const field = fieldByRef.get(ref.fieldRef);
    // An explicit malformed or duplicate source is an invalid override, not
    // absence. It must never fall through to a field template, evaluator, or
    // projection write while its addressed source truth is contradictory.
    const sourceIssues = source
      ? source.value
        ? validateCellExpression(source.value)
        : [{ code: 'malformed-source' as const, message: 'A source record could not be decoded.' }]
      : [];
    const explicitSourceInvalid = sources.duplicates.has(key) || sourceIssues.length > 0;
    if (sourceIssues.length > 0) (issues ??= []).push(...sourceIssues);
    const expression = explicitSourceInvalid ? undefined : source ? source.value : field?.defaultExpression;
    if (!source) {
      const defaultIssues = validateCellExpression(expression);
      if (defaultIssues.length > 0) (issues ??= []).push(...defaultIssues);
    }
    const issueList = issues ?? EMPTY_CELL_EXPRESSION_ISSUES;
    const cacheState = cache?.value.sourceRevision && source?.revision && cache.value.sourceRevision !== source.revision ? 'stale' : cache ? 'current' : undefined;
    const projectionState: FoldedCellExpression['projectionState'] = !cache && !provenance
      ? 'missing'
      : !cache || !provenance
        ? 'partial'
        : source?.revision
          && cache.value.sourceRevision === source.revision
          && provenance.value.sourceRevision === source.revision
          ? 'current'
          : 'stale';
    return foldedCellExpression({
      ref,
      expression,
      cachedValue: cache?.value,
      provenance: provenance?.value,
      source: issueList.length > 0 ? 'invalid' : source ? 'cell' : 'field-default',
      cacheState,
      projectionState,
      hasSource: !!source,
      hasRawCache: !!rawCache,
      hasRawProvenance: !!rawProvenance,
      sourceExpectedCurrent: source?.expectedCurrent,
      cacheExpectedCurrent: rawCache?.expectedCurrent,
      provenanceExpectedCurrent: rawProvenance?.expectedCurrent,
      explicitSourceInvalid,
      issues: issueList,
    });
  });
}
