// Structural decoding only. These saved snapshots do not grant permission or prove current access.
type JsonRecord = Record<string, unknown>;

const EVIDENCE_KEYS = new Set([
  'kind', 'evidence_ref', 'source_record_ref', 'connection_ref', 'consent', 'lease',
]);
const CONSENT_KEYS = new Set([
  'consent_ref', 'subject_ref', 'purpose_ref', 'field_refs', 'granted_at', 'expires_at',
]);
const LEASE_KEYS = new Set([
  'lease_ref', 'subject_ref', 'purpose_ref', 'field_refs', 'observed_at', 'expires_at',
  'revocation_ref', 'revocation_target',
]);
const CONNECTED_FACT_KEYS = new Set([
  'fact_ref', 'claim_kinds', 'value', 'evidence_refs', 'source',
]);
const CONNECTED_FACT_SOURCE_KEYS = new Set([
  'kind', 'connection_ref', 'access_lease_ref', 'consent_ref', 'observed_at',
  'field_scope', 'expires_at', 'revocable',
]);

export type ConnectedSourceEvidence = {
  kind: 'connected-source-evidence';
  evidence_ref: string;
  source_record_ref: string;
  connection_ref: string;
  consent: {
    consent_ref: string;
    subject_ref: string;
    purpose_ref: string;
    field_refs: string[];
    granted_at: string;
    expires_at: string;
  };
  lease: {
    lease_ref: string;
    subject_ref: string;
    purpose_ref: string;
    field_refs: string[];
    observed_at: string;
    expires_at: string;
    revocation_ref: string;
    revocation_target: string;
  };
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function requiredRef(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(value)) {
    throw new Error(`${label} must be a valid reference.`);
  }
  return value;
}

function exactKeys(value: JsonRecord, keys: ReadonlySet<string>, label: string): void {
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function exactIso(value: unknown, label: string): number {
  const text = requiredRef(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    throw new Error(`${label} must be an exact ISO timestamp.`);
  }
  return milliseconds;
}

function fields(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} is required.`);
  const result = value.map((field) => requiredRef(field, label));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates.`);
  return result;
}

function sameFields(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('\u0000') === [...right].sort().join('\u0000');
}

function jsonSafe(value: unknown, seen = new Set<object>(), budget = { remaining: 10000 }, depth = 0): boolean {
  if (--budget.remaining < 0 || depth > 64) return false;
  if (typeof value === 'string') return value.length <= 65536;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => jsonSafe(entry, seen, budget, depth + 1))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.keys(value).every(key => {
        const property = Object.getOwnPropertyDescriptor(value, key);
        return !!property && 'value' in property && jsonSafe(property.value, seen, budget, depth + 1);
      });
  seen.delete(value);
  return valid;
}

/**
 * Decodes recorded scope metadata. Current permission, ownership, expiry and
 * revocation must be checked separately by their owners before use; this pure
 * function neither reads live permissions nor authorizes attachment.
 */
export function readConnectedSourceEvidence(value: unknown): ConnectedSourceEvidence {
  if (!jsonSafe(value)) throw new Error('Connected source evidence must be bounded JSON data.');
  const evidence = record(value);
  if (!evidence) throw new Error('Connected source evidence is required.');
  exactKeys(evidence, EVIDENCE_KEYS, 'Connected source evidence');
  if (evidence.kind !== 'connected-source-evidence') {
    throw new Error('Connected source evidence kind is invalid.');
  }
  const consent = record(evidence.consent);
  const lease = record(evidence.lease);
  if (!consent || !lease) throw new Error('Connected evidence requires scoped consent and lease metadata.');
  exactKeys(consent, CONSENT_KEYS, 'Connected evidence consent');
  exactKeys(lease, LEASE_KEYS, 'Connected evidence lease');

  const consentFields = fields(consent.field_refs, 'consent.field_refs');
  const leaseFields = fields(lease.field_refs, 'lease.field_refs');
  const subjectRef = requiredRef(consent.subject_ref, 'consent.subject_ref');
  const purposeRef = requiredRef(consent.purpose_ref, 'consent.purpose_ref');
  if (requiredRef(lease.subject_ref, 'lease.subject_ref') !== subjectRef) {
    throw new Error('Connected evidence consent and lease subjects disagree.');
  }
  if (requiredRef(lease.purpose_ref, 'lease.purpose_ref') !== purposeRef) {
    throw new Error('Connected evidence consent and lease purposes disagree.');
  }
  if (!sameFields(consentFields, leaseFields)) {
    throw new Error('Connected evidence consent and lease fields disagree.');
  }
  const grantedAt = exactIso(consent.granted_at, 'consent.granted_at');
  const observedAt = exactIso(lease.observed_at, 'lease.observed_at');
  const consentExpiresAt = exactIso(consent.expires_at, 'consent.expires_at');
  const leaseExpiresAt = exactIso(lease.expires_at, 'lease.expires_at');
  if (observedAt < grantedAt || leaseExpiresAt <= observedAt || consentExpiresAt < leaseExpiresAt) {
    throw new Error('Connected evidence access time bounds are invalid.');
  }
  const revocationTarget = requiredRef(lease.revocation_target, 'lease.revocation_target');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(revocationTarget)) {
    throw new Error('lease.revocation_target is invalid.');
  }

  return {
    kind: 'connected-source-evidence',
    evidence_ref: requiredRef(evidence.evidence_ref, 'evidence_ref'),
    source_record_ref: requiredRef(evidence.source_record_ref, 'source_record_ref'),
    connection_ref: requiredRef(evidence.connection_ref, 'connection_ref'),
    consent: {
      consent_ref: requiredRef(consent.consent_ref, 'consent.consent_ref'),
      subject_ref: subjectRef,
      purpose_ref: purposeRef,
      field_refs: consentFields,
      granted_at: requiredRef(consent.granted_at, 'consent.granted_at'),
      expires_at: requiredRef(consent.expires_at, 'consent.expires_at'),
    },
    lease: {
      lease_ref: requiredRef(lease.lease_ref, 'lease.lease_ref'),
      subject_ref: subjectRef,
      purpose_ref: purposeRef,
      field_refs: leaseFields,
      observed_at: requiredRef(lease.observed_at, 'lease.observed_at'),
      expires_at: requiredRef(lease.expires_at, 'lease.expires_at'),
      revocation_ref: requiredRef(lease.revocation_ref, 'lease.revocation_ref'),
      revocation_target: revocationTarget,
    },
  };
}

/**
 * Build a structurally consistent reference result. The caller must still
 * check current ownership and permission before dispatching or attaching it.
 */
export function connectedSourceEvidenceResult(input: {
  connectionRef: string;
  evidenceRef: string;
  sourceEvidence: unknown;
  connectedSourceFacts?: unknown;
}): JsonRecord {
  const evidence = readConnectedSourceEvidence(input.sourceEvidence);
  if (requiredRef(input.connectionRef, 'connection_ref') !== evidence.connection_ref) {
    throw new Error('Connected source evidence belongs to a different connection.');
  }
  if (requiredRef(input.evidenceRef, 'evidence_ref') !== evidence.evidence_ref) {
    throw new Error('Connected source evidence does not match the requested reference.');
  }
  const connectedSourceFacts = readConnectedSourceFacts(input.connectedSourceFacts, evidence);
  return {
    connection_ref: evidence.connection_ref,
    evidence_ref: evidence.evidence_ref,
    source_record_ref: evidence.source_record_ref,
    consent: evidence.consent,
    lease: evidence.lease,
    connected_source_facts: connectedSourceFacts,
  };
}

/** Preserve the complete observed-content claim, including nested source
 * provenance. A flattened fact is invalid because the matcher cannot justify
 * it without connection, lease, consent, field scope, observation, expiry,
 * and revocability. */
export function readConnectedSourceFacts(
  value: unknown,
  evidence: ConnectedSourceEvidence,
): JsonRecord[] {
  evidence = readConnectedSourceEvidence(evidence);
  if (!Array.isArray(value) || value.length === 0 || !jsonSafe(value)) {
    throw new Error('Connected source facts with full provenance are required.');
  }
  const seenFacts = new Set<string>();
  return value.map((entry) => {
    const fact = record(entry);
    const source = record(fact?.source);
    if (!fact || !source) throw new Error('Connected source fact provenance is required.');
    exactKeys(fact, CONNECTED_FACT_KEYS, 'Connected source fact');
    exactKeys(source, CONNECTED_FACT_SOURCE_KEYS, 'Connected source fact provenance');
    const factRef = requiredRef(fact.fact_ref, 'fact_ref');
    if (seenFacts.has(factRef)) throw new Error('Connected source fact references must be unique.');
    seenFacts.add(factRef);
    const claimKinds = fields(fact.claim_kinds, 'claim_kinds');
    const evidenceRefs = fields(fact.evidence_refs, 'evidence_refs');
    const fieldScope = fields(source.field_scope, 'source.field_scope');
    if (!jsonSafe(fact.value) || fact.value === null || fact.value === '') {
      throw new Error('Connected source fact value is invalid.');
    }
    if (!evidenceRefs.includes(evidence.evidence_ref)) {
      throw new Error('Connected source fact does not cite the materialized evidence.');
    }
    if (
      requiredRef(source.connection_ref, 'source.connection_ref') !== evidence.connection_ref
      || requiredRef(source.access_lease_ref, 'source.access_lease_ref') !== evidence.lease.lease_ref
      || requiredRef(source.consent_ref, 'source.consent_ref') !== evidence.consent.consent_ref
      || requiredRef(source.expires_at, 'source.expires_at') !== evidence.lease.expires_at
      || source.revocable !== true
    ) throw new Error('Connected source fact provenance does not match its evidence receipt.');
    if (fieldScope.some((fieldRef) => !evidence.lease.field_refs.includes(fieldRef))) {
      throw new Error('Connected source fact exceeds the consented field scope.');
    }
    const observedAt = exactIso(source.observed_at, 'source.observed_at');
    if (
      observedAt < exactIso(evidence.consent.granted_at, 'consent.granted_at')
      || observedAt >= exactIso(evidence.lease.expires_at, 'lease.expires_at')
    ) throw new Error('Connected source fact observation is outside the evidence access window.');
    return {
      fact_ref: factRef,
      claim_kinds: claimKinds,
      value: fact.value,
      evidence_refs: evidenceRefs,
      source: {
        kind: requiredRef(source.kind, 'source.kind'),
        connection_ref: evidence.connection_ref,
        access_lease_ref: evidence.lease.lease_ref,
        consent_ref: evidence.consent.consent_ref,
        observed_at: requiredRef(source.observed_at, 'source.observed_at'),
        field_scope: fieldScope,
        expires_at: evidence.lease.expires_at,
        revocable: true,
      },
    };
  });
}
