/**
 * enforce-retention-once.mjs — ONE-SHOT tick-driven RETENTION ENFORCER (the ethos bounded-retention seam).
 *
 * DESIGN (code-verified, ethos-operator plan fires 10-16): per-kind record retention is a DATA process, NOT an
 * engine change. A `RecordPayload::None` retraction removes the address from what the store's root can
 * reach, and content the kept roots cannot reach is not carried into the next generation, so the bytes go.
 * CORRECTED 2026-09-09: this used to name `cas_reclaim.rs` and a boot-time reclaim pass. That whole
 * subsystem is deleted. It ran at boot, behind a budget the runner computed, and on the live app the budget
 * was always larger than the store, so it never ran at all and the content file reached 429 GB holding under
 * 35 MB of data. Freeing is now the commit's own work: the commit that changed a path already knows what
 * that path no longer reaches. The retraction contract below is UNCHANGED and is what this file is about.
 * A real retraction is a write-batch entry that OMITS the payload field
 * entirely (engine-operation-target lib.rs:880-885: absent payload key → None). ⚠️ `payload:null` is a TRAP:
 * it serializes to the bytes "null" = Inline("null"), a tombstone (read-current found:true, stays reachable,
 * still reachable, so the bytes are kept), live-proven fire-16. So this process reads
 * `record-retention-policy` rows, and for each `expiring(ttl_ms)` policy enumerates that kind's current
 * records via its scoped kind-index feed, dates each via extractWriteTimeMs, and RETRACTS (omit-payload) the
 * ones older than ttl — then reads back each address to VERIFY it is gone. Existing boot-reclaim reclaims the
 * bytes on the next boot. ZERO engine change, ZERO runner rebuild.
 *
 * SAFETY: the retraction DECISION is the pure, 18/18-tested leaf (lib/retention-enforcement.mjs) — only
 * `expiring` retracts; undated/edge/invalid rows are NEVER retracted (under-retract, never over-retract).
 * A kind with NO retraction descriptor (unknown address shape) is SKIPPED, never guessed. Every retraction is
 * readback-verified (found:false) and BOUNDED per run. history(keep_generations) on unique-address kinds is
 * reported as mis-classified (misclassifiedHistoryKinds) but NEVER retracted (that is a policy decision).
 *
 * Env: BITFIELD_TARGET_CARRIER_URL (or BITFIELD_TARGET_CARRIER_URL_FILE, the path the runtime publishes its address into) (or PORT), BITFIELD_DISPATCH_PARTITION (or BITFIELD_PARTITION).
 */
import { addressesToRetract, extractWriteTimeMs, misclassifiedHistoryKinds } from './lib/retention-enforcement.mjs';
import { readFileSync as __readFileSync } from 'node:fs';

// Per-kind retraction descriptor (DATA, single choke point — like sweep-decisions KIND_LIST_PATH, NOT an
// if/switch on kind). VERIFIED from each producer's write shape (plan fire-13) AND from a live read-only probe
// (fire-15): find-current-items returns each item's address ENCODED (a multihash / label-hash) which canNOT be
// used as address_label — so the retraction address is RECONSTRUCTED from the record's payload via
// `address_prefix + payload[id_field]` (the exact string the producer wrote), then re-labeled by `address_mode`.
//   .result/.error → address = `package::ai-records-producer::<result|error>::${payload.request_id}` (label-hash)
//   produce-grounded-audit → address = payload.id (already `produce-grounded-audit::<iso>`) (identity_text)
//   queue-drain-audit → address = `queue-drain-audit::${payload.id}` (identity_text)
// To retention-enforce a NEW kind: add ONE row here + a record-retention-policy DATA row. No logic change.
export const RETRACT_DESCRIPTOR = {
  'ai-records-producer.result': { address_mode: 'label-hash', index_path: 'ai-records-producer-result-index', address_prefix: 'package::ai-records-producer::result::', id_field: 'request_id', unique_address: true },
  'ai-records-producer.error':  { address_mode: 'label-hash', index_path: 'ai-records-producer-error-index', address_prefix: 'package::ai-records-producer::error::', id_field: 'request_id', unique_address: true },
  'produce-grounded-audit':     { address_mode: 'identity_text', index_path: 'produce-grounded-audit-index', address_prefix: '', id_field: 'id', unique_address: true },
  'queue-drain-audit':          { address_mode: 'identity_text', index_path: 'queue-drain-audit-index', address_prefix: 'queue-drain-audit::', id_field: 'id', unique_address: true },
  // agent-decision: net-new decisions accumulate unbounded (boot-reclaim handles status-churn overwrites);
  // decided_at is a real ISO ts, id === address (agent-decision::<detKey>), and it is NOT an idempotency gate
  // (sweep-cursor + action-intent-receipt drive idempotency) → safe to bound via expiring(ttl).
  'agent-decision':             { address_mode: 'identity_text', index_path: 'agent-decision-index', address_prefix: '', id_field: 'id', unique_address: true },
  // ai-execution-run: address = package::ai-execution-history::run::address_token(stable_id), stable_id = id
  // without the `ai-execution-run:` prefix (ingest-session-artifacts-to-runs.py:197). token_transform
  // reconstructs it (LIVE-VALIDATED: read-current found:true). self_address_field prefers a self-describing
  // `record_address` (L090) when present (future producers). Caller-supplied-address records (id not starting
  // `ai-execution-run:`, no record_address) fail-safe skip via the strip_prefix guard.
  'ai-execution-run':           { address_mode: 'label-hash', index_path: 'ai-execution-run-index', self_address_field: 'record_address', id_field: 'id', strip_prefix: 'ai-execution-run:', token_transform: true, address_prefix: 'package::ai-execution-history::run::', unique_address: true },
};

/** Reconstruct the PLAIN address label the producer wrote, from a record's payload (never the encoded item.address).
 *  Returns null when the id field is missing (→ the record is NOT retracted: fail-safe). */
export function reconstructAddress(desc, payload) {
  if (!desc || typeof desc.id_field !== 'string') return null;
  // L090 preferred: a record that self-describes its plain address wins outright (no reconstruction).
  if (typeof desc.self_address_field === 'string') {
    const a = payload && payload[desc.self_address_field];
    if (typeof a === 'string' && a) return a;
  }
  let id = payload && payload[desc.id_field];
  if (typeof id !== 'string' || !id) return null;
  // Optional DATA-driven token transform (e.g. ai-execution-run: address = prefix + address_token(stable_id),
  // stable_id = id without `strip_prefix`). strip_prefix acts as a shape guard — an id lacking it (a
  // caller-supplied address record) returns null → fail-safe skip, never a wrong retraction.
  if (desc.token_transform) {
    if (typeof desc.strip_prefix === 'string') {
      if (!id.startsWith(desc.strip_prefix)) return null;
      id = id.slice(desc.strip_prefix.length);
    }
    id = id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  }
  return `${desc.address_prefix || ''}${id}`;
}
// Bound retractions per run; a large backlog drains across ticks (each run bounded). DATA-tunable via
// BITFIELD_RETENTION_CAP (L083: capable default 300, overridable — e.g. a small first production run).
const RETRACT_CAP = (() => { const n = parseInt(process.env.BITFIELD_RETENTION_CAP || '', 10); return Number.isFinite(n) && n > 0 ? n : 300; })();
// Self-gate: on a clock-tick-driven schedule this process fires every tick, but retention only needs to run
// periodically. Skip if the last run (its own newest retention-enforcement-audit) is within this interval.
// DATA-tunable via BITFIELD_RETENTION_MIN_INTERVAL_MS (default 7 days = weekly). 0 disables the gate.
const MIN_INTERVAL_MS = (() => { const n = parseInt(process.env.BITFIELD_RETENTION_MIN_INTERVAL_MS || '', 10); return Number.isFinite(n) && n >= 0 ? n : 7 * 24 * 60 * 60 * 1000; })();

/**
 * PURE planner: given policies + the current records per kind + descriptors + now, return the exact retraction
 * writes (address_label/address_mode/path_labels, NO payload field = RecordPayload::None retraction) + skips
 * + the history mis-class report. (An entry MUST omit payload; `payload:null` is a tombstone, not a retraction — L137.)
 * @param {Array<object>} policies - record-retention-policy payloads.
 * @param {Record<string, Array<{address:string, payload:object}>>} recordsByKind
 * @param {Record<string, object>} descriptors - RETRACT_DESCRIPTOR
 * @param {number} now_ms
 * @param {number} [cap]
 * @returns {{writes:Array<object>, skipped:Array<object>, misclass:Array<object>, decided:Array<object>}}
 */
export function planRetractions(policies, recordsByKind, descriptors, now_ms, cap = RETRACT_CAP) {
  const writes = [], skipped = [], misclassInput = [], decided = [];
  for (const policy of Array.isArray(policies) ? policies : []) {
    const kind = policy && policy.record_kind;
    const recs = (recordsByKind && recordsByKind[kind]) || [];
    const desc = descriptors[kind] || null;
    misclassInput.push({ policy, unique_address: !!(desc && desc.unique_address), current_count: recs.length });
    const usable = !!(desc && !desc.report_only && typeof desc.id_field === 'string');
    // When usable, reconstruct the PLAIN address from each payload (the encoded item.address is unusable as
    // address_label). A record whose id field is missing yields null → never retracted (fail-safe). When NOT
    // usable, a placeholder keeps the ttl count meaningful so the skip is logged with the eligible count.
    const rows = recs.map((r) => { const pay = r.payload || r; return { address: usable ? reconstructAddress(desc, pay) : '__no_descriptor__', write_time_ms: extractWriteTimeMs(pay, r.address) }; });
    const decision = addressesToRetract(policy, rows, now_ms);
    decided.push({ kind, class: policy && policy.retention && policy.retention.class, candidate: decision.retract.length, reason: decision.reason, skipped_reason: decision.skipped_reason });
    if (!decision.retract.length) continue;
    if (!usable) { skipped.push({ kind, reason: desc ? 'report_only descriptor' : 'no retraction descriptor (unknown address shape) — NOT retracting', count: decision.retract.length }); continue; }
    for (const addr of decision.retract) {
      if (writes.length >= cap) { skipped.push({ kind, reason: `RETRACT_CAP ${cap} hit — remaining drain next run`, count: decision.retract.length - writes.length }); break; }
      // A real retraction OMITS the payload field entirely → RecordPayload::None (engine-operation-target
      // lib.rs:880-885: an ABSENT payload key → Ok(None); `payload:null` is a TRAP — it serializes to the
      // bytes "null" = Inline("null"), a tombstone that read-current shows found:true and the root still
      // reaches, so the bytes stay). Live-proven fire-16: omit gives found:false and drops from the index;
      // null persists.
      writes.push({ address_label: addr, address_mode: desc.address_mode, path_labels: ['current-item', desc.index_path] });
    }
  }
  return { writes, skipped, misclass: misclassifiedHistoryKinds(misclassInput), decided };
}

// ── I/O shell (only runs as a process; a test importing this module skips main()) ──────────────────────────
// A supervisor entry is written once and frozen; a runtime that picks its port at
// startup has an address that changes every time it starts. So the supervisor is given
// the PATH of the file the runtime publishes its address into, which does not change,
// rather than the address, which does. Nothing is searched for: the path arrives as DATA
// exactly as the URL does. Still inlined here only because this file mounts no lib/ sibling yet,
// NOT because the engine forbids one: materialize_input_create_only (native_process.rs:557) creates
// every mount-path component, so a declared lib/carrier.mjs mount resolves and this copy can then be
// deleted. Proof: processes/carrier-resolution.test.mjs. This file is also the ENTRY of
// build-retention-fly-bundle.mjs, and a Fly process-script really must be single-file; the bundler
// already inlines relative imports, so importing the sibling is the bundler's job, not a blocker.
function publishedCarrierAddress() {
  const file = process.env.BITFIELD_TARGET_CARRIER_URL_FILE;
  if (!file) return null;
  try {
    return __readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null; // the runtime is not up, or has not published yet
  }
}
const CARRIER_URL = process.env.BITFIELD_TARGET_CARRIER_URL
  || publishedCarrierAddress()
  || process.env.BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS
  || (process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : null);
const PARTITION_LABEL = process.env.BITFIELD_DISPATCH_PARTITION || process.env.BITFIELD_PARTITION || null;
const KIND_LIST_PATH = { 'ai-records-producer.result': 'ai-records-producer-result-index', 'ai-records-producer.error': 'ai-records-producer-error-index', 'produce-grounded-audit': 'produce-grounded-audit-index', 'queue-drain-audit': 'queue-drain-audit-index' };

async function fetchBasis() { const r = await fetch(new URL('/boot', CARRIER_URL), { headers: { 'Cache-Control': 'no-cache' } }); const j = await r.json(); return j[0].running_command_list_basis; }
async function postTarget(target, body, basis, timeoutMs = 25000) {
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), timeoutMs);
  try { const r = await fetch(new URL('/target/' + encodeURIComponent(target), CARRIER_URL), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bitfield-Running-Command-List-Basis': basis }, body: JSON.stringify(body), signal: ac.signal }); const x = await r.text(); try { return JSON.parse(x); } catch { return null; } }
  catch { return null; } finally { clearTimeout(to); }
}
// find-current-items KEEPING each item's exact address (retraction targets the returned address, never a
// reconstructed one). Reads BOTH the kind index AND published-record (both-paths, deploy-safe), dedup by address.
async function findKindWithAddress(kind, basis) {
  const idx = KIND_LIST_PATH[kind];
  const paths = idx ? [idx, 'published-record'] : ['published-record'];
  const seen = new Set(); const out = [];
  for (const listPath of paths) {
    const j = await postTarget('slot::find-current-items', { operation: 'find-current-items', in: listPath, where: { all: [{ field: 'kind', in: [kind] }] }, include: ['payload', 'address'] }, basis);
    const a = Array.isArray(j) ? j : (j?.items || j?.results || []);
    for (const x of a) {
      const address = (x && x.record && x.record.address) || (x && x.address) || null;
      const payload = (x && x.payload) || x;
      if (!address || typeof address !== 'string') continue;
      if (seen.has(address)) continue; seen.add(address);
      out.push({ address, payload });
    }
  }
  return out;
}
async function writeBatch(writes, basis) { const j = await postTarget('engine.operation.label-addressed', { operation_label: 'engine.operation.write-batch', writes }, basis); return !!(j && (j.write_count || j.ok || j.status === 200 || j.writes_committed)); }
async function isGone(addressLabel, addressMode, pathLabels, basis) { const j = await postTarget('engine.operation.label-addressed', { operation_label: 'engine.operation.read-current', partition_label: PARTITION_LABEL, address_label: addressLabel, address_mode: addressMode, path_labels: pathLabels }, basis); return !!(j && j.found === false); }

async function main() {
  if (!CARRIER_URL || !PARTITION_LABEL) { console.error('A carrier address and a partition are required. The address comes from BITFIELD_TARGET_CARRIER_URL, or the file named by BITFIELD_TARGET_CARRIER_URL_FILE, or the runtime ambient BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS, or PORT. The partition comes from BITFIELD_DISPATCH_PARTITION or BITFIELD_PARTITION.'); process.exit(1); }
  const basis = await fetchBasis();
  const now_ms = Date.now();
  // Self-gate (weekly by default): skip if the newest prior run is within MIN_INTERVAL_MS. Idempotent-by-time,
  // survives missed ticks (reads log truth, not in-process state). MIN_INTERVAL_MS=0 disables.
  if (MIN_INTERVAL_MS > 0) {
    const auditIdx = await postTarget('slot::find-current-items', { operation: 'find-current-items', in: 'retention-enforcement-audit-index', where: { all: [{ field: 'kind', in: ['retention-enforcement-audit'] }] }, include: ['payload'], limit: 2000 }, basis);
    const audits = Array.isArray(auditIdx) ? auditIdx : (auditIdx?.items || auditIdx?.results || []);
    let lastMs = 0;
    for (const a of audits) { const t = Date.parse((a?.payload || a)?.ran_at || ''); if (Number.isFinite(t) && t > lastMs) lastMs = t; }
    if (lastMs && now_ms - lastMs < MIN_INTERVAL_MS) {
      console.log(`[retention] skipped: last run ${Math.round((now_ms - lastMs) / 3600000)}h ago < interval ${Math.round(MIN_INTERVAL_MS / 3600000)}h`);
      return;
    }
  }
  // Read all retention policies (self-describing kind).
  const policyRows = await findKindWithAddress('record-retention-policy', basis);
  const policies = policyRows.map((r) => r.payload).filter((p) => p && p.record_kind);
  // Enumerate current records for every kind that has BOTH a policy AND a retraction descriptor.
  const kindsToScan = [...new Set(policies.map((p) => p.record_kind).filter((k) => RETRACT_DESCRIPTOR[k] && !RETRACT_DESCRIPTOR[k].report_only))];
  const recordsByKind = {};
  for (const k of kindsToScan) recordsByKind[k] = await findKindWithAddress(k, basis);
  const plan = planRetractions(policies, recordsByKind, RETRACT_DESCRIPTOR, now_ms);
  // Retract one address at a time, guarded write + readback-verify (found:false) before counting reclaimed.
  let retracted = 0, verifyFail = 0;
  for (const w of plan.writes) {
    const ok = await writeBatch([{ partition_label: PARTITION_LABEL, ...w }], basis);
    if (!ok) { verifyFail++; continue; }
    const gone = await isGone(w.address_label, w.address_mode, w.path_labels, basis);
    if (gone) retracted++; else verifyFail++;
  }
  // Emit a self-describing audit record (its own kind → never re-materializes the aggregate; scoped index).
  const auditId = `retention-enforcement-run::${new Date(now_ms).toISOString()}`;
  await writeBatch([{ partition_label: PARTITION_LABEL, address_label: auditId, address_mode: 'identity_text', path_labels: ['current-item', 'retention-enforcement-audit-index'], payload: {
    kind: 'retention-enforcement-audit', id: auditId, ran_at: new Date(now_ms).toISOString(),
    policies: policies.length, planned: plan.writes.length, retracted, verify_fail: verifyFail,
    skipped: plan.skipped, decided: plan.decided, misclassified_history: plan.misclass,
  } }], basis);
  console.log(`[retention] policies=${policies.length} planned=${plan.writes.length} retracted=${retracted} verify_fail=${verifyFail} misclass=${plan.misclass.length} skipped=${plan.skipped.length}`);
}
if (CARRIER_URL) { main().catch((e) => { console.error('Fatal:', e); process.exit(1); }); }
