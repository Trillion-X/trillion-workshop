import {
  decodeCanonicalArtifactRef,
  type CanonicalArtifactRef,
} from '../../../../record-voice-and-meetings/read-data/content-media-evidence';

// packages/content-media-evidence/read-data/exact-result-inventory.ts
//
// PURPOSE
// Turn a complete, package-bound page chain of materialized evidence relations
// into an exact inventory of already-materialized results. This is a pure read
// model: it adds no storage, scheduler, provider adapter, cache, migration, or
// semantic classifier.
//
// NON-NEGOTIABLE INVARIANTS
//  1. Only the existing canonical materialized-relation shape is admitted:
//     one canonical artifact source, one exact target, one declared role, owner
//     context, and one idempotency identity.
//  2. A result satisfies only its declared observable. Media type, display
//     name, byte length, file path, semantic key, and target identity never
//     turn it into an original-byte substitute.
//  3. relation_id is the relation identity. Exact duplicates merge; the same
//     relation_id with different semantics conflicts and refuses the batch.
//  4. A page stream is evidence only as a complete cursor chain. A truncated
//     chain cannot become a smaller complete inventory.
//  5. Rows are package-bound. A relation from another package is not borrowed
//     merely because its rows arrived in this feed.

const SCHEMA_VERSION = 'content-media.exact-result-inventory/v1';
const RELATION_KIND = 'content-media.relation.record';

export class ExactEvidenceInventoryError extends Error {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ExactEvidenceInventoryError';
    this.details = details;
  }

  readonly details: Record<string, unknown>;
}

export type ExactResultInventoryRelation = {
  relationId: string;
  declaredObservable: unknown;
  target: unknown;
  resultArtifact: CanonicalArtifactRef;
  coverage: {
    satisfies: 'declared-observable-only';
    neverSatisfies: readonly ['immutable-bytes'];
  };
};

export type ExactResultInventory = {
  kind: 'content-media.exact-result-inventory';
  schemaVersion: typeof SCHEMA_VERSION;
  packageName: string;
  results: ExactResultInventoryRelation[];
  summary: {
    pagesSupplied: number;
    relationRowsSupplied: number;
    uniqueResults: number;
    complete: true;
  };
};

type PlainRecord = Record<string, unknown>;
type AdmittedPage = {
  cursor: string | null;
  nextCursor: string | null;
  rows: unknown[];
};
type AdmittedRelation = {
  relationId: string;
  declaredObservable: unknown;
  target: unknown;
  resultArtifact: CanonicalArtifactRef;
  contextRef: { subject_ref: string };
  idempotencyRef: string;
};

function plainObject(value: unknown, label: string): PlainRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExactEvidenceInventoryError(`${label} must be an object`, { field: label });
  }
  return value as PlainRecord;
}

function rejectUnknownFields(value: PlainRecord, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unknown.length !== 0) {
    throw new ExactEvidenceInventoryError(`${label} has fields outside this exact contract`, {
      field: label,
      unknownFields: unknown.sort(),
    });
  }
}

function exactText(value: unknown, label: string, maxLength = 1024): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    value !== value.trim()
  ) {
    throw new ExactEvidenceInventoryError(`${label} must be 1..${maxLength} non-whitespace characters`, {
      field: label,
    });
  }
  return value;
}

function jsonValue(value: unknown, label: string): unknown {
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint' ||
    (typeof value === 'number' && !Number.isFinite(value))
  ) {
    throw new ExactEvidenceInventoryError(`${label} is not valid JSON data`, { field: label });
  }
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`));
  const source = plainObject(value, label);
  const output: PlainRecord = {};
  for (const key of Object.keys(source).sort()) output[key] = jsonValue(source[key], `${label}.${key}`);
  return output;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(jsonValue(value, 'value'));
}

function exactReference(value: unknown, label: string): unknown {
  if (typeof value === 'string') return exactText(value, label);
  const reference = plainObject(value, label);
  if (Object.keys(reference).length === 0) {
    throw new ExactEvidenceInventoryError(`${label} must not be empty`, { field: label });
  }
  return jsonValue(reference, label);
}

function admittedContext(value: unknown): { subject_ref: string } {
  const context = plainObject(value, 'relation.context_ref');
  rejectUnknownFields(context, ['subject_ref'], 'relation.context_ref');
  return { subject_ref: exactText(context.subject_ref, 'relation.context_ref.subject_ref') };
}

function admittedArtifact(value: unknown): CanonicalArtifactRef {
  const source = plainObject(value, 'relation.source_ref');
  rejectUnknownFields(source, ['artifact_ref'], 'relation.source_ref');
  const artifact = decodeCanonicalArtifactRef(source.artifact_ref);
  if (!artifact) throw new ExactEvidenceInventoryError('relation.source_ref.artifact_ref is not canonical', {
    field: 'relation.source_ref.artifact_ref',
  });
  return artifact;
}

function relationLikePayload(value: unknown): boolean {
  return plainObjectOrFalse(value) != null && [
    'relation_id',
    'source_ref',
    'target_ref',
    'role_ref',
  ].some((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function plainObjectOrFalse(value: unknown): PlainRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as PlainRecord
    : null;
}

function admittedRelation(value: unknown): AdmittedRelation {
  const relation = plainObject(value, 'relation');
  rejectUnknownFields(
    relation,
    ['kind', 'relation_id', 'source_ref', 'target_ref', 'role_ref', 'context_ref', 'idempotency_ref'],
    'relation',
  );
  if (relation.kind !== RELATION_KIND) {
    throw new ExactEvidenceInventoryError('relation kind mismatch', {
      expected: RELATION_KIND,
      received: relation.kind,
    });
  }
  const resultArtifact = admittedArtifact(relation.source_ref);
  const contextRef = admittedContext(relation.context_ref);
  return {
    relationId: exactText(relation.relation_id, 'relation.relation_id'),
    declaredObservable: exactReference(relation.role_ref, 'relation.role_ref'),
    target: exactReference(relation.target_ref, 'relation.target_ref'),
    resultArtifact,
    contextRef,
    idempotencyRef: exactText(relation.idempotency_ref, 'relation.idempotency_ref'),
  };
}

function admittedRow(value: unknown, index: number, packageName: string): AdmittedRelation | null {
  const label = `rows[${index}]`;
  const row = plainObject(value, label);
  rejectUnknownFields(row, ['address', 'role', 'source_package', 'payload', 'blocker'], label);
  if (row.address !== undefined) exactText(row.address, `${label}.address`, 4096);
  if (row.role !== undefined) exactText(row.role, `${label}.role`, 256);
  if (row.blocker !== undefined && row.blocker !== null) {
    throw new ExactEvidenceInventoryError(`${label} carries a blocker; evidence is incomplete`, { index });
  }
  if (exactText(row.source_package, `${label}.source_package`, 256) !== packageName) {
    throw new ExactEvidenceInventoryError(`${label} belongs to another package`, { index });
  }
  if (relationLikePayload(row.payload)) return admittedRelation(row.payload);
  jsonValue(row.payload, `${label}.payload`);
  return null;
}

function admittedPage(value: unknown, index: number, packageName: string): AdmittedPage {
  const label = `pages[${index}]`;
  const page = plainObject(value, label);
  rejectUnknownFields(page, ['schemaVersion', 'cursor', 'nextCursor', 'rows'], label);
  if (page.schemaVersion !== SCHEMA_VERSION) {
    throw new ExactEvidenceInventoryError(`${label} schema version mismatch`, {
      expected: SCHEMA_VERSION,
      received: page.schemaVersion,
    });
  }
  if (!Array.isArray(page.rows)) {
    throw new ExactEvidenceInventoryError(`${label}.rows must be an array`, { field: `${label}.rows` });
  }
  return {
    cursor: page.cursor === null ? null : exactText(page.cursor, `${label}.cursor`, 4096),
    nextCursor: page.nextCursor === null ? null : exactText(page.nextCursor, `${label}.nextCursor`, 4096),
    rows: page.rows.map((row, rowIndex) => admittedRow(row, rowIndex, packageName)),
  };
}

function validatePageChain(pages: readonly AdmittedPage[]): void {
  if (pages.length === 0) {
    throw new ExactEvidenceInventoryError('at least one evidence page is required', { field: 'pages' });
  }
  const seenCursors = new Set<string>();
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const isLast = index === pages.length - 1;
    if (index === 0 && page.cursor !== null) {
      throw new ExactEvidenceInventoryError('the first page cursor must be null', { index });
    }
    if (index > 0 && page.cursor !== pages[index - 1].nextCursor) {
      throw new ExactEvidenceInventoryError('page cursor does not continue the previous page', { index });
    }
    if (page.cursor !== null) {
      if (seenCursors.has(page.cursor)) {
        throw new ExactEvidenceInventoryError('duplicate page cursor', { index, cursor: page.cursor });
      }
      seenCursors.add(page.cursor);
    }
    if (isLast && page.nextCursor !== null) {
      throw new ExactEvidenceInventoryError('page sequence is truncated: final nextCursor is not null', {
        index,
        nextCursor: page.nextCursor,
      });
    }
    if (!isLast && page.nextCursor === null) {
      throw new ExactEvidenceInventoryError('a non-final page must name its next cursor', { index });
    }
  }
}

function mergeRelations(relations: readonly AdmittedRelation[]): ExactResultInventoryRelation[] {
  const byRelationId = new Map<string, { admitted: AdmittedRelation; canonical: string }>();
  for (const admitted of relations) {
    const canonical = canonicalJson(admitted);
    const existing = byRelationId.get(admitted.relationId);
    if (existing && existing.canonical !== canonical) {
      throw new ExactEvidenceInventoryError(
        'relation_id conflict: one relation identity has two different semantics',
        { relationId: admitted.relationId },
      );
    }
    if (!existing) byRelationId.set(admitted.relationId, { admitted, canonical });
  }
  return [...byRelationId.values()]
    .sort((left, right) => left.admitted.relationId.localeCompare(right.admitted.relationId))
    .map(({ admitted }) => ({
      relationId: admitted.relationId,
      declaredObservable: structuredClone(admitted.declaredObservable),
      target: structuredClone(admitted.target),
      resultArtifact: structuredClone(admitted.resultArtifact),
      coverage: {
        satisfies: 'declared-observable-only',
        neverSatisfies: ['immutable-bytes'] as const,
      },
    }));
}

/**
 * Admit a complete package-bound relation-page chain and emit exact
 * materialized-result facts. Neither the input pages nor their rows are mutated.
 */
export function exactResultInventoryFromPages(input: unknown): ExactResultInventory {
  const request = plainObject(input, 'inventory');
  rejectUnknownFields(request, ['schemaVersion', 'packageName', 'pages'], 'inventory');
  if (request.schemaVersion !== SCHEMA_VERSION) {
    throw new ExactEvidenceInventoryError('inventory schema version mismatch', {
      expected: SCHEMA_VERSION,
      received: request.schemaVersion,
    });
  }
  const packageName = exactText(request.packageName, 'inventory.packageName', 256);
  if (!Array.isArray(request.pages)) {
    throw new ExactEvidenceInventoryError('pages must be an array', { field: 'pages' });
  }

  const pages = request.pages.map((page, index) => admittedPage(page, index, packageName));
  validatePageChain(pages);
  const admittedRelations = pages.flatMap((page) => page.rows.filter((row): row is AdmittedRelation => row !== null));
  const results = mergeRelations(admittedRelations);
  return {
    kind: 'content-media.exact-result-inventory',
    schemaVersion: SCHEMA_VERSION,
    packageName,
    results,
    summary: {
      pagesSupplied: pages.length,
      relationRowsSupplied: admittedRelations.length,
      uniqueResults: results.length,
      complete: true,
    },
  };
}
