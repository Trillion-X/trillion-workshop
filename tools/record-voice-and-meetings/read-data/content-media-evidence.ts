//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic projection reader for content/media evidence packages. Maintained
// evidence surfaces provide role-keyed rows; package panels consume roles from
// this reader instead of scanning package-wide published records.
//
// =============================================================================

export type EvidenceBlocker = {
  kind?: string;
  code?: string;
  message?: string;
  owner?: string;
  severity?: string;
  proof_gate?: string;
};

export type EvidenceProjectionRow = {
  address?: string;
  role?: string;
  payload?: unknown;
  source_package?: string;
  blocker?: EvidenceBlocker;
};

export type EvidenceRelationRecord = {
  kind: 'content-media.relation.record';
  relation_id: string;
  source_ref: unknown;
  target_ref: unknown;
  role_ref: unknown;
  context_ref?: unknown;
  receipt_ref?: unknown;
  state_ref?: unknown;
  error_ref?: unknown;
  idempotency_ref?: string;
};

export type ArtifactPayloadAddressMode = 'address_bytes' | 'addressed_chunks';

export type CanonicalArtifactRef = {
  kind: 'canonical-artifact-ref/v1';
  payload_address: string;
  payload_address_mode: ArtifactPayloadAddressMode;
  integrity_hash: string;
  byte_length: number;
  media_type: string;
  display_name: string;
  provenance: Record<string, unknown>;
};

export type CanonicalArtifactLimits = {
  readonly max_byte_length?: number;
  readonly max_display_name_chars?: number;
};

const UNSAFE_ACTIVE_MEDIA = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml']);
const DEFAULT_MAX_ARTIFACT_BYTES = 1_073_741_824;

/** The one place the relation-address grammar is spelled.
 *
 * A relation address is `PREFIX + enc(scope) :: enc(idempotency)`. The scope
 * component is always owner-derived (an admission's authority scope); only the
 * idempotency leaf may originate with a caller.
 *
 * This lives here, in the package's pure ref module, because the writer and the
 * reader of an address must agree on its grammar and neither may own it. They
 * used to spell it separately: `materialize-artifact-target.ts` composed it to
 * WRITE and `read-guarded-artifact-target.ts` recomposed it to VERIFY a stored
 * row sits at an address matching its own fields. Two copies of a grammar are
 * one edit away from a writer that emits a shape its reader rejects, and the
 * divergence is silent until rows exist in both shapes, at which point the
 * reader reports a data-integrity failure for what is really a code split.
 */
export const RELATION_ADDRESS_PREFIX = 'package::content-media-evidence::relation::';

export function relationAddress(scopeRef: string, idempotencyRef: string): string {
  return `${RELATION_ADDRESS_PREFIX}${encodeURIComponent(scopeRef)}::${encodeURIComponent(idempotencyRef)}`;
}

export function isRelationAddress(value: string): boolean {
  return value.startsWith(RELATION_ADDRESS_PREFIX);
}

function requiredText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function safeDisplayName(value: unknown, maxChars: number): string | null {
  const name = requiredText(value);
  if (!name || name.length > maxChars || /[\\/\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..') return null;
  return name;
}

/** Decode the successor contract without inferring retrieval mode from an
 * address prefix, integrity hash, file name, or media type. */
export function decodeCanonicalArtifactRef(
  value: unknown,
  limits: CanonicalArtifactLimits = {},
): CanonicalArtifactRef | null {
  if (!isRecord(value) || value.kind !== 'canonical-artifact-ref/v1') return null;
  const payload_address = requiredText(value.payload_address);
  const integrity_hash = requiredText(value.integrity_hash);
  const media_type = requiredText(value.media_type)?.toLowerCase() ?? null;
  const display_name = safeDisplayName(value.display_name, limits.max_display_name_chars ?? 255);
  const byte_length = value.byte_length;
  const mode = value.payload_address_mode;
  if (!payload_address || !integrity_hash || !media_type || !display_name || !isRecord(value.provenance)) return null;
  if (mode !== 'address_bytes' && mode !== 'addressed_chunks') return null;
  if (!Number.isSafeInteger(byte_length) || (byte_length as number) < 0 || (byte_length as number) > (limits.max_byte_length ?? DEFAULT_MAX_ARTIFACT_BYTES)) return null;
  if (UNSAFE_ACTIVE_MEDIA.has(media_type)) return null;
  return {
    kind: 'canonical-artifact-ref/v1',
    payload_address,
    payload_address_mode: mode,
    integrity_hash,
    byte_length: byte_length as number,
    media_type,
    display_name,
    provenance: value.provenance,
  };
}

export type EvidenceRelationProjectionRow = {
  address?: string;
  relationId: string;
  sourceKey: string;
  targetKey: string;
  roleKey: string;
  relation: EvidenceRelationRecord;
};

export type EvidencePipelineConfig = {
  kind?: string;
  package?: string;
  roles?: Record<string, readonly string[]>;
  artifact_roles?: Record<string, readonly string[]>;
  execution_capabilities?: readonly string[];
  projection_lanes?: readonly string[];
  proof_gates?: readonly string[];
};

export type EvidenceProjection = {
  config: EvidencePipelineConfig | null;
  rowsByRole: Record<string, EvidenceProjectionRow[]>;
  relationsBySource: Record<string, EvidenceRelationProjectionRow[]>;
  relationsByTarget: Record<string, EvidenceRelationProjectionRow[]>;
  blockers: EvidenceBlocker[];
};

const CONFIG_KIND = 'content-media.evidence-pipeline.config';
const BLOCKER_KIND = 'content-media.evidence.blocker';
const RELATION_KIND = 'content-media.relation.record';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rowsFrom(raw: unknown): EvidenceProjectionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is EvidenceProjectionRow => isRecord(row));
}

function isEvidenceConfigFor(payload: unknown, packageName: string): payload is EvidencePipelineConfig {
  return (
    isRecord(payload)
    && payload.kind === CONFIG_KIND
    && payload.package === packageName
    && isRecord(payload.roles)
  );
}

function isBlocker(payload: unknown): payload is EvidenceBlocker {
  return isRecord(payload) && payload.kind === BLOCKER_KIND && typeof payload.code === 'string';
}

function stableRefKey(ref: unknown): string {
  if (typeof ref === 'string' && ref.trim()) return ref.trim();
  if (isRecord(ref)) {
    for (const key of ['address', 'id', 'ref', 'record_id', 'source_id', 'target_id']) {
      const value = ref[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return JSON.stringify(ref ?? null);
}

function isRelationRecord(payload: unknown): payload is EvidenceRelationRecord {
  return (
    isRecord(payload)
    && payload.kind === RELATION_KIND
    && typeof payload.relation_id === 'string'
    && payload.relation_id.length > 0
    && payload.source_ref !== undefined
    && payload.target_ref !== undefined
    && payload.role_ref !== undefined
  );
}

function missingFeedBlocker(packageName: string): EvidenceBlocker {
  return {
    kind: BLOCKER_KIND,
    code: 'content-media.evidence-projection.missing',
    message: 'Live material is not ready for this page yet.',
    owner: 'workflow/process-session/http-client/stored-bytes',
    severity: 'blocked',
  };
}

export function readEvidenceProjection(raw: unknown, packageName: string): EvidenceProjection {
  const rows = rowsFrom(raw);
  const config = rows
    .map((row) => row.payload)
    .find((payload): payload is EvidencePipelineConfig => isEvidenceConfigFor(payload, packageName)) ?? null;

  const rowsByRole: Record<string, EvidenceProjectionRow[]> = {};
  const relationsBySource: Record<string, EvidenceRelationProjectionRow[]> = {};
  const relationsByTarget: Record<string, EvidenceRelationProjectionRow[]> = {};
  const blockers: EvidenceBlocker[] = [];

  if (rows.length === 0) {
    blockers.push(missingFeedBlocker(packageName));
  }

  if (!config) {
    blockers.push({
      kind: BLOCKER_KIND,
      code: 'content-media.evidence-config.missing',
      message: 'This page is missing its material setup.',
      owner: packageName,
      severity: 'blocked',
    });
  }

  for (const row of rows) {
    const role = typeof row.role === 'string' ? row.role : null;
    if (role) {
      rowsByRole[role] = [...(rowsByRole[role] ?? []), row];
    }
    if (row.blocker) blockers.push(row.blocker);
    if (isBlocker(row.payload)) blockers.push(row.payload);
    if (isRelationRecord(row.payload)) {
      const relation = row.payload;
      const sourceKey = stableRefKey(relation.source_ref);
      const targetKey = stableRefKey(relation.target_ref);
      const roleKey = stableRefKey(relation.role_ref);
      const projected = {
        address: row.address,
        relationId: relation.relation_id,
        sourceKey,
        targetKey,
        roleKey,
        relation,
      };
      relationsBySource[sourceKey] = [...(relationsBySource[sourceKey] ?? []), projected];
      relationsByTarget[targetKey] = [...(relationsByTarget[targetKey] ?? []), projected];
    }
  }

  for (const gate of config?.proof_gates ?? []) {
    blockers.push({
      kind: BLOCKER_KIND,
      code: 'content-media.proof-gate.pending',
      message: 'A required check is still running.',
      owner: packageName,
      severity: 'blocked',
      proof_gate: gate,
    });
  }

  return { config, rowsByRole, relationsBySource, relationsByTarget, blockers };
}

export function evidencePayloads<T>(projection: EvidenceProjection, role: string): T[] {
  return (projection.rowsByRole[role] ?? [])
    .map((row) => row.payload)
    .filter((payload): payload is T => isRecord(payload));
}

export function evidenceBlockerText(blocker: EvidenceBlocker): string {
  return blocker.message ?? 'Live material is not ready yet.';
}

export function evidenceRelationsForSource(
  projection: EvidenceProjection,
  sourceRef: unknown,
): EvidenceRelationProjectionRow[] {
  return projection.relationsBySource[stableRefKey(sourceRef)] ?? [];
}

export function evidenceRelationsForTarget(
  projection: EvidenceProjection,
  targetRef: unknown,
): EvidenceRelationProjectionRow[] {
  return projection.relationsByTarget[stableRefKey(targetRef)] ?? [];
}
