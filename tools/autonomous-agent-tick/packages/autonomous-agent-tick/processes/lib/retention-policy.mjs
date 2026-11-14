/**
 * retention-policy.mjs — the machine-readable RETENTION DESCRIPTOR contract (WS3b-T4, pure leaf).
 *
 * ROOT (WS3b-cas-growth-byte-attribution §L055): disk = O(all activity ever) because a record has no
 * storage-class/retention axis — every admitted record becomes permanent CAS content. The fix is ONE
 * self-describing DATA attribute per record kind, declared by the OWNING package as a `record-retention-policy`
 * row (things-to-store-and-run.json admission input), read GENERICALLY by the compaction fold (WS3b-T3/T7).
 * The engine NEVER enumerates kinds (L090/enum-dissolution): it reads a class + a count/ttl/basis-field.
 *
 * This leaf is the SSOT of the descriptor SHAPE + validity predicate. The compaction reader (Rust, T7)
 * enforces the SAME contract; this documents it and is exercised by the schema test over the real rows.
 *
 * CLASSES (retention.class):
 *   durable                  — the CURRENT version of each identity is kept permanently (user truth);
 *                              superseded versions reclaimable beyond the crash-safety window.
 *   history(keep_generations)— keep the N most-recent versions per identity; older reclaimable.
 *                              N=1 == "keep only current" (kills O(N^2) full-record re-append).
 *   expiring(ttl_ms)         — reclaim ANY version (incl. current) whose write-time is older than ttl_ms
 *                              (pure exhaust: errors, audit markers, transient envelopes).
 *   re-derivable(basis_ref_field) — replace the payload with a pointer to the basis address named by the
 *                              record's <basis_ref_field>; the derived bytes are dropped, re-derivable on demand.
 *
 * Absence of a policy for a kind => the fold treats it as `durable` (fail-safe: never auto-drop unclassified truth).
 */
export const RETENTION_CLASSES = ['durable', 'history', 'expiring', 're-derivable'];
export const DEFAULT_CLASS = 'durable';

/**
 * Validate one record-retention-policy payload. Returns { ok, errors[] }. Pure, no I/O.
 * Enforces: required top-level fields; class in the closed Physics set; the per-class required parameter;
 * and address/field agreement is checked by the caller (it has the address).
 */
export function validateRetentionPolicy(payload) {
  const errors = [];
  const p = payload || {};
  if (p.kind !== 'record-retention-policy') errors.push(`kind must be "record-retention-policy" (got ${JSON.stringify(p.kind)})`);
  if (typeof p.record_kind !== 'string' || !p.record_kind) errors.push('record_kind must be a non-empty string');
  if (typeof p.owner_package !== 'string' || !p.owner_package) errors.push('owner_package must be a non-empty string');
  const r = p.retention;
  if (!r || typeof r !== 'object') {
    errors.push('retention must be an object');
    return { ok: false, errors };
  }
  if (!RETENTION_CLASSES.includes(r.class)) {
    errors.push(`retention.class must be one of ${RETENTION_CLASSES.join('|')} (got ${JSON.stringify(r.class)})`);
    return { ok: false, errors };
  }
  if (r.class === 'history') {
    if (!Number.isInteger(r.keep_generations) || r.keep_generations < 1) errors.push('history requires integer keep_generations >= 1');
  } else if (r.class === 'expiring') {
    if (!Number.isInteger(r.ttl_ms) || r.ttl_ms <= 0) errors.push('expiring requires integer ttl_ms > 0');
  } else if (r.class === 're-derivable') {
    if (typeof r.basis_ref_field !== 'string' || !r.basis_ref_field) errors.push('re-derivable requires a non-empty basis_ref_field naming the record field that points at the basis address');
  }
  return { ok: errors.length === 0, errors };
}

/** Resolve the effective retention for a kind from a kind->policy map, defaulting to durable when absent. */
export function retentionForKind(policyByKind, recordKind) {
  const p = policyByKind && policyByKind[recordKind];
  return p && p.retention ? p.retention : { class: DEFAULT_CLASS };
}
