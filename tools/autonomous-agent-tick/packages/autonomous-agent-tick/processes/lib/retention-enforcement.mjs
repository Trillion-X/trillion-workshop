/**
 * retention-enforcement.mjs — PURE retention-evaluation leaf (zero I/O, fully testable, zero data-loss risk).
 *
 * DESIGN (code-verified 2026-07-24, operator plan fire-10; the freeing half CORRECTED 2026-09-09):
 * the store keeps exactly what its root can reach, and `RecordPayload::None` (a retraction) removes an
 * address from that reach, so the bytes are not carried into the next generation. There is NO per-record
 * wall-timestamp anywhere in the store, so per-kind `expiring(ttl)` enforcement is NOT an engine change.
 * It is a scheduled DATA process that RETRACTS past-ttl exhaust addresses via `engine.operation.write-batch`
 * (RecordPayload::None), after which the bytes go.
 *
 * WHAT CHANGED AND WHY IT IS WORTH READING. This used to name `cas_reclaim.rs` and a boot-time reclaim
 * pass. That subsystem is deleted. It ran at boot behind a budget the runner computed from disk statistics
 * plus an env override, and on the live app the override made the budget larger than the store, so it never
 * ran and the content file reached 429 GB while holding under 35 MB of data. The retraction contract this
 * leaf implements was never the problem and is unchanged; only the owner that frees the bytes moved, from
 * a pass that scans at boot to the commit itself, which already knows what the path it changed no longer
 * reaches. This leaf is the pure decision
 * core: given a kind's policy + the kind's current {address, write_time_ms} rows, return exactly which
 * addresses to retract. The I/O shell (enumerate via the scoped kind-index, dispatch guarded write-batch
 * retractions, readback-verify) wraps this leaf.
 *
 * SAFETY INVARIANTS (enforced + tested):
 *  - Only `expiring` retracts. durable/history/re-derivable NEVER retract from this leaf.
 *  - A row without a finite numeric write_time_ms is NEVER retracted (fail-safe — never drop truth we can't date).
 *  - Strict `<` at the ttl boundary (write_time == cutoff is KEPT).
 *  - An invalid policy retracts NOTHING (returns skipped_reason).
 *  - Clock skew where now_ms is small/negative → cutoff small/negative → nothing retracted (safe).
 *
 * WHY history does NOT retract here (real finding, operator plan fire-11): `history(keep_generations)`
 * is a VERSION-retention concept ("keep N most-recent versions PER IDENTITY"). For OVERWRITTEN addresses
 * (sweep-cursor, agent-produce-state, *ledger-entry, delivery-gap) the store already keeps current (== keep=1);
 * keeping N>1 versions is a store capability, NOT a write-batch op (write-batch only sets current, and
 * it cannot resurrect old versions). How many versions survive is now the store's `versions_kept`, which
 * bounds the kept roots. For UNIQUE-address records (ai-execution-run::<id> keep=3,
 * agent-decision::<hash> keep=3) each identity has exactly 1 version (1 <= N), so history frees NOTHING and
 * those accumulate unbounded DESPITE having a policy. That is unchanged by the store rewrite, because a
 * unique live address is reachable from the root by definition. history-classed unique-address kinds are therefore
 * MIS-CLASSIFIED for growth-bounding and need review (reclassify to `expiring`, or add a distinct
 * "keep newest N ADDRESSES of a kind" class) — a policy/contract decision, surfaced by
 * `misclassifiedHistoryKinds()`, NOT silently reinterpreted here (reinterpreting the contract could drop
 * records an author never intended — L029/L094).
 */
import { validateRetentionPolicy } from './retention-policy.mjs';

/**
 * Which addresses to retract for ONE kind's policy over its current rows.
 * @param {object} policy - a record-retention-policy payload ({kind, record_kind, owner_package, retention}).
 * @param {Array<{address:string, write_time_ms:number}>} rows - the kind's current records (from the scoped kind-index).
 * @param {number} now_ms - current wall time in ms (supplied by the I/O shell; NEVER Date.now() in a leaf).
 * @returns {{retract:string[], reason:string, skipped_reason?:string}}
 */
export function addressesToRetract(policy, rows, now_ms) {
  const v = validateRetentionPolicy(policy);
  if (!v.ok) return { retract: [], reason: '', skipped_reason: `invalid policy: ${v.errors.join('; ')}` };
  if (!Number.isFinite(now_ms)) return { retract: [], reason: '', skipped_reason: `now_ms must be a finite number (got ${now_ms})` };
  const list = Array.isArray(rows) ? rows : [];
  const r = policy.retention;

  if (r.class === 'expiring') {
    const cutoff = now_ms - r.ttl_ms;
    const retract = [];
    for (const x of list) {
      const t = x && x.write_time_ms;
      // fail-safe: only retract rows we can positively date as older than the cutoff.
      if (typeof t === 'number' && Number.isFinite(t) && t < cutoff && typeof x.address === 'string' && x.address) {
        retract.push(x.address);
      }
    }
    return { retract, reason: `expiring ttl_ms=${r.ttl_ms} cutoff_ms=${cutoff} kept=${list.length - retract.length}` };
  }
  if (r.class === 'durable') {
    return { retract: [], reason: 'durable — current kept permanently; boot-reclaim drops superseded (no write-batch retraction)' };
  }
  if (r.class === 're-derivable') {
    return { retract: [], reason: `re-derivable(basis=${r.basis_ref_field}) — payload-swap-to-basis-pointer mechanism, not retraction (separate build)` };
  }
  if (r.class === 'history') {
    return {
      retract: [],
      reason: `history keep_generations=${r.keep_generations} — version-retention (engine/boot-reclaim domain); write-batch retraction cannot enforce it. Unique-address kinds under history accumulate unbounded — see misclassifiedHistoryKinds()`,
    };
  }
  return { retract: [], reason: '', skipped_reason: `unknown class ${JSON.stringify(r.class)}` };
}

/**
 * Extract a record's write-time in ms for ttl comparison — PURE, fail-safe.
 * Tries, in order: an explicit numeric ms field; an ISO-string field; a trailing ISO segment in the address
 * (many exhaust addresses embed their write instant, e.g. `package::ai-records-producer::result::2026-07-24T...`).
 * Returns `null` when no valid instant is found — and the leaf NEVER retracts a null-dated row (fail-safe:
 * a record we cannot positively date is treated as not-yet-expired, so extraction bugs cause under-retraction
 * (keep too much), NEVER over-retraction (drop something still needed).
 * @param {object} record - the record payload.
 * @param {string} [address] - the record's address label (its trailing ISO is a fallback source).
 * @returns {number|null} epoch ms, or null if undatable.
 */
export function extractWriteTimeMs(record, address) {
  const r = record || {};
  // 1) explicit numeric ms fields (most precise).
  for (const f of ['write_time_ms', 'created_at_ms', 'ts_ms', 'timestamp_ms']) {
    const v = r[f];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  // 2) ISO-string / parseable date fields. Covers the real write-time field of every expiring kind:
  //    ai-records-producer.result=completed_at, .error=observed_at, produce-grounded-audit=produced_at,
  //    queue-drain-audit=at (verified against each producer's write shape 2026-07-24).
  for (const f of ['completed_at', 'observed_at', 'produced_at', 'decided_at', 'created_at', 'timestamp', 'ts', 'written_at', 'at', 'time', 'ended_at', 'started_at']) {
    const v = r[f];
    if (typeof v === 'string' && v) { const t = Date.parse(v); if (Number.isFinite(t)) return t; }
  }
  // 3) a trailing ISO instant embedded in the record id or the address (e.g. `...::2026-07-24T06:00:00.000Z`).
  for (const s of [typeof r.id === 'string' ? r.id : '', typeof address === 'string' ? address : '']) {
    const m = s.match(/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z?)/);
    if (m) { const t = Date.parse(m[1]); if (Number.isFinite(t)) return t; }
  }
  return null; // undatable → leaf keeps it (fail-safe).
}

/**
 * Report kinds whose `history` policy cannot bound them because they are unique-address exhaust.
 * The caller passes, per policy, whether the kind's records are unique-address (distinct id per instance).
 * @param {Array<{policy:object, unique_address:boolean, current_count:number}>} kinds
 * @returns {Array<{record_kind:string, keep_generations:number, current_count:number, recommendation:string}>}
 */
export function misclassifiedHistoryKinds(kinds) {
  const out = [];
  for (const k of Array.isArray(kinds) ? kinds : []) {
    const p = k && k.policy;
    const r = p && p.retention;
    if (r && r.class === 'history' && k.unique_address === true) {
      out.push({
        record_kind: p.record_kind,
        keep_generations: r.keep_generations,
        current_count: k.current_count,
        recommendation: `unique-address + history(keep=${r.keep_generations}) => never reclaimed. Reclassify to expiring(ttl_ms) OR introduce a "keep newest N addresses of kind" class.`,
      });
    }
  }
  return out;
}
