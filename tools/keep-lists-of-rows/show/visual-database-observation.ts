// Observation boundary for Visual Database presentation.
//
// UI observations are deliberately value-blind. Human-authored values,
// addresses, labels, owner payloads, and storage scopes never cross this
// boundary. Each event family has one exact allowlist so a future call site
// cannot accidentally turn observability into a second data export.

export interface VisualDatabaseObservationMap {
  'visual-database:descriptor-mutation': {
    draft_hash: string;
    operation_set_hash: string;
    owner_namespace_hash: string;
    addressed_identity_hash: string;
    base_revision_hash: string;
    current_revision_hash: string;
    result_revision_hash: string;
    phase:
      | 'draft-created'
      | 'materialized'
      | 'deduplicated'
      | 'rebased'
      | 'conflicted'
      | 'transported'
      | 'feed-observed'
      | 'current-observed'
      | 'settled';
    elapsed_ms: number;
    observed_at: string;
  };
  'visual-database:mutation-settlement': {
    attempt_hash: string;
    owner_family: string;
    addressed_identity_hash: string;
    expected_revision_hash: string;
    current_revision_hash: string;
    stage: string;
    elapsed_ms: number;
    observed_at: string;
  };
  'visual-database:owner-reply': {
    kind: 'field-direct-readback';
    state: 'verified';
    field_count: 1;
    observed_at: string;
  };
}

const OBSERVATION_KEYS: {
  [K in keyof VisualDatabaseObservationMap]: readonly (keyof VisualDatabaseObservationMap[K])[];
} = {
  'visual-database:descriptor-mutation': [
    'draft_hash',
    'operation_set_hash',
    'owner_namespace_hash',
    'addressed_identity_hash',
    'base_revision_hash',
    'current_revision_hash',
    'result_revision_hash',
    'phase',
    'elapsed_ms',
    'observed_at',
  ],
  'visual-database:mutation-settlement': [
    'attempt_hash',
    'owner_family',
    'addressed_identity_hash',
    'expected_revision_hash',
    'current_revision_hash',
    'stage',
    'elapsed_ms',
    'observed_at',
  ],
  'visual-database:owner-reply': ['kind', 'state', 'field_count', 'observed_at'],
};

/** Synchronous, deterministic, one-way presentation identity. Raw owner
 * addresses, revisions, values, and source text never enter event detail. */
export function opaqueVisualDatabaseObservationHash(domain: string, value: string): string {
  const bytes = new TextEncoder().encode(`${domain}\0${value}`);
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64-${hash.toString(16).padStart(16, '0')}`;
}

export function assertVisualDatabaseObservation<K extends keyof VisualDatabaseObservationMap>(
  eventName: K,
  detail: VisualDatabaseObservationMap[K],
): void {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    throw new Error('Visual Database observation detail must be an object.');
  }
  const actual = Object.keys(detail).sort();
  const expected = [...OBSERVATION_KEYS[eventName]].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Visual Database observation ${eventName} contains unapproved fields.`);
  }
}

export function dispatchVisualDatabaseObservation<K extends keyof VisualDatabaseObservationMap>(
  eventName: K,
  detail: VisualDatabaseObservationMap[K],
): void {
  assertVisualDatabaseObservation(eventName, detail);
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
}
