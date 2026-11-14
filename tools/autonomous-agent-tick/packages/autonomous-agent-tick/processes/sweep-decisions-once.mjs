/**
 * sweep-decisions-once.mjs — ONE-SHOT tick-driven RECEIPT-GATE (L063 structural barrier).
 *
 * Fired per clock::tick via trigger -> execute_definition -> compute.process (one-shot).
 * Durability is tied to the durable clock; there is NO long-running process to die.
 *
 * THE COMPLETION CONTRACT (transport-agnostic primitive — see plan
 * _shared/plans/2026-07-05-decide-act-terminal-receipt-primitive/): a tick reaches a terminal
 * record ONLY via an Action-Intent RECEIPT that exists iff the producer output
 *   (1) VALIDATE — parses as ONE action-intent object with the required fields (raw advice text
 *       has no capability/owner_target/artifact -> fails -> NO record written, fail-closed);
 *   (2) GUARD — passed to ai-action-guard.request-guard-check (best-effort verdict captured);
 *   (3) RECEIPT — written at a DETERMINISTIC address = hash(agent+capability+intent+source_run)
 *       so retries/restarts/wording-variance collapse to ONE receipt (the address IS the
 *       anti-double-dispatch guard — L063 pattern ported from autonomous-tennis-coach/autonomous-worker.mjs);
 *   (4) READBACK_VERIFY — the receipt address is read back and its intent_hash re-checked.
 * Advisory notes are structurally impossible as terminal records: no valid intent -> no receipt.
 *
 * PHASE: with no live credential/owner dispatch wired yet, every receipt is phase=draft
 * (dispatched=false) carrying the FULLY-FORMED artifact + owner_target for a later DISPATCH step.
 * The real-owner dispatch (content-distribution.submit-message-egress / run-publish-intent /
 * timed-action) + a real guard authority are the next plan units; this file installs the barrier.
 *
 * No god package: VALIDATE/RECEIPT are generic write-batch + a schema check; GUARD dispatches the
 * existing ai-action-guard owner; the effect owners stay untouched (this owns no send/post logic).
 *
 * Env: BITFIELD_TARGET_CARRIER_URL (or BITFIELD_TARGET_CARRIER_URL_FILE, the path the runtime publishes its address into), BITFIELD_DISPATCH_PARTITION,
 *      BITFIELD_DISPATCH_AGENT_REF (optional), BITFIELD_DISPATCH_RESULT_PREFIX (optional).
 */
import { createHash } from 'node:crypto';
// ARTIFACT-ONCE-BY-HASH (WS3b-T4): the FULL artifact was inlined into receipt.artifact AND
// decision.decision_text (two full copies per intent). Both now carry a ref; the text is stored once.
import { buildArtifactRef, buildArtifactBlobWrite } from './lib/artifact-store.mjs';
import { resolveCarrier, resolvePartition, CARRIER_AND_PARTITION_REQUIRED } from './lib/carrier.mjs';
// A supervisor entry is written once and frozen; a runtime that picks its port at
// startup has an address that changes every time it starts. So the supervisor is given
// the PATH of the file the runtime publishes its address into, which does not change,
// rather than the address, which does. Nothing is searched for: the path arrives as DATA
// exactly as the URL does. The chain now lives in ./lib/carrier.mjs; the claim that a sibling
// import could not resolve was stale, and this file was already importing ./lib/artifact-store.mjs
// while asserting it.
const CARRIER_URL = resolveCarrier();
const PARTITION_LABEL = resolvePartition();
const AGENT_REF = process.env.BITFIELD_DISPATCH_AGENT_REF || '';
const RESULT_PREFIX = process.env.BITFIELD_DISPATCH_RESULT_PREFIX || 'package::ai-records-producer::result::';
// Required fields that distinguish a real action-intent from advice text (fail-closed schema).
export const REQUIRED_INTENT_FIELDS = ['capability', 'owner_target', 'artifact', 'goal_ancestry', 'status'];
const hash12 = (t) => createHash('sha256').update(String(t)).digest('hex').slice(0, 12);
async function fetchBasis() { const r = await fetch(new URL('/boot', CARRIER_URL), { headers: { 'Cache-Control': 'no-cache' } }); const j = await r.json(); return j[0].running_command_list_basis; }
// BOUNDED (cont.225 stall fix): every carrier call has an AbortController timeout so a hanging owner
// dispatch / slow read can NEVER block the in-engine 120s compute past its budget. A timed-out or failed
// call returns null (callers already treat null as not-ok), so the receipt+cursor still commit and the
// sweep never freezes on one bad downstream call. This is the deepest root of the 18.6h receipt freeze:
// dispatchToOwner was an UNBOUNDED execute_definition that hung, killing the tick before the cursor advanced.
async function postTarget(target, body, basis, timeoutMs = 25000) {
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), timeoutMs);
  try { const r = await fetch(new URL('/target/' + encodeURIComponent(target), CARRIER_URL), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bitfield-Running-Command-List-Basis': basis }, body: JSON.stringify(body), signal: ac.signal }); const x = await r.text(); try { return JSON.parse(x); } catch { return null; } }
  catch { return null; } finally { clearTimeout(to); }
}
// L126 exhaust-off: operational-exhaust kinds are moved off the shared published-record aggregate onto
// their own dedicated <kind>-index list-path (the producer write-step writes there). To exhaust-off a new
// kind: add ONE row to KIND_LIST_PATH here (the producer + reader-feed repoints are done per-package).
// Every kind NOT in this map (sweep-cursor, action-intent-owner-map, ai-guard-limit, ai-guard-state,
// confidence-threshold) stays on published-record. produce-grounded-audit is now exhaust-off'd onto
// produce-grounded-audit-index (producer produce-grounded.mjs writes there; findKind reads both-paths).
// This map is the single choke point.
const KIND_LIST_PATH = { 'ai-execution-run': 'ai-execution-run-index', 'agent-decision': 'agent-decision-index', 'action-intent-receipt': 'action-intent-receipt-index', 'produce-grounded-audit': 'produce-grounded-audit-index', 'ai-memory-record': 'ai-memory-index', 'sweep-cursor': 'sweep-cursor-index' };
// BOTH-PATHS ROBUST (deploy-safe, self-healing): for a mapped kind, read BOTH its index path AND published-record,
// dedup by id. This makes the reader correct regardless of whether existing records have been backfilled off
// published-record yet — no deploy/refold/backfill ordering dependency. After backfill the published-record query
// returns ~0 (kind index, cheap), so it converges to index-only with zero further code change.
async function findKind(kind, basis) {
  const idx = KIND_LIST_PATH[kind];
  const paths = idx ? [idx, 'published-record'] : ['published-record'];
  const seen = new Set();
  const out = [];
  for (const listPath of paths) {
    const j = await postTarget('slot::find-current-items', { operation: 'find-current-items', in: listPath, where: { all: [{ field: 'kind', in: [kind] }] }, include: ['payload'] }, basis);
    const a = Array.isArray(j) ? j : (j?.items || j?.results || []);
    for (const x of a) {
      const p = x.payload || x;
      if (!p) continue;
      const id = p.id;
      if (typeof id === 'string') { if (seen.has(id)) continue; seen.add(id); }
      out.push(p);
    }
  }
  return out;
}
async function readResult(iso, basis) { const j = await postTarget('engine.operation.label-addressed', { operation_label: 'engine.operation.read-current', partition_label: PARTITION_LABEL, address_label: RESULT_PREFIX + iso, address_mode: 'label-hash' }, basis); if (!j || j.found === false) { return null; } const p = j.payload ?? j.value ?? j.ok?.payload ?? j.ok?.value ?? j.ok ?? null; return p && typeof p === 'object' ? p : null; }
async function readAddr(addr, basis) { const j = await postTarget('engine.operation.label-addressed', { operation_label: 'engine.operation.read-current', partition_label: PARTITION_LABEL, address_label: addr, address_mode: 'identity_text' }, basis); if (!j || j.found === false) { return null; } return j.payload ?? j.value ?? j.ok?.payload ?? j.ok?.value ?? j.ok ?? null; }
// (1) VALIDATE: extract ONE action-intent object from the producer item; raw advice -> null.
export function parseActionIntent(item) {
  if (!item) return null;
  let obj = null;
  if (item && typeof item === 'object' && item.capability) obj = item; // producer may return the object directly
  if (!obj) { const t = String(item.text || item || '').trim(); const m = t.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch { obj = null; } } }
  if (!obj || typeof obj !== 'object') return null;
  const missing = REQUIRED_INTENT_FIELDS.filter((f) => obj[f] == null || String(obj[f]).trim() === '');
  return missing.length ? { invalid: true, missing } : obj;
}
// Resolve which ai-action-guard LIMIT governs this intent (DATA-driven, no capability enum): the
// intent may name a guard_limit_ref; otherwise outward/money actions default to the outside-contact
// limit. The guard POLICY is owned by ai-action-guard (its ai-guard-limit/ai-guard-state records);
// this gate only READS it (L093 — no re-owning guard logic).
export function resolveGuardLimit(intent, limits) {
  if (!Array.isArray(limits) || !limits.length) return null;
  if (intent && intent.guard_limit_ref) return limits.find((l) => l && l.id === intent.guard_limit_ref) || null;
  return limits.find((l) => l && /outside-contact/.test(String(l.id || ''))) || null;
}
// Resolve the intent's capability to a REAL dispatchable owner address (the primitive's
// capability_owner_map, plan §4). DATA-driven (L090, no capability enum in code): each row carries a
// `match_prefix` tested against the intent capability; the FIRST matching row supplies the real
// owner_target (live send) + draft_target (safe no-credential queue) + needs_credential. An unmatched
// capability resolves to owner_resolved:false -> the receipt stays a draft and is NEVER dispatched
// (fail-closed: an unknown owner cannot be sent to). The model's advisory owner_target is preserved
// on the receipt for provenance but the RESOLVED address is the one a future DISPATCH step uses.
export function resolveOwnerTarget(intent, ownerRows) {
  if (!intent || !Array.isArray(ownerRows) || !ownerRows.length) return { resolved_owner_target: null, draft_target: null, needs_credential: null, owner_resolved: false };
  const cap = String(intent.capability || '');
  const row = ownerRows.find((r) => r && typeof r.match_prefix === 'string' && cap.startsWith(r.match_prefix)) || null;
  if (!row) return { resolved_owner_target: null, draft_target: null, needs_credential: null, owner_resolved: false, draft_payload_template: null };
  return {
    resolved_owner_target: row.owner_target || null,
    draft_target: row.draft_target || row.owner_target || null,
    needs_credential: row.needs_credential ?? null,
    owner_resolved: !!row.owner_target,
    draft_payload_template: row.draft_payload_template || null,
    send_payload_template: row.send_payload_template || null,
    guard_limit_ref: row.guard_limit_ref || null,
  };
}
// DISPATCH TARGET SELECTION (pure, DATA-driven L090): decide whether a validated+guarded intent
// LIVE-sends to its real owner or materializes a SAFE draft. The LIVE path fires ONLY on a POSITIVE
// guard approval (verdict ok/approved — NOT merely "no limit"; fail-closed), a resolved real send
// owner, no outstanding credential need, AND an owner-map `send_payload_template` (the owner's own
// payload language, L098). Otherwise the SAFE draft path (draft_target + draft_payload_template) is
// chosen. This makes the LIVE-SEND path DATA-enabled per capability (flip an ai-guard-state to 'ok'
// + add a send_payload_template) with ZERO engine change; external-contact capabilities stay gated
// because their guard state is not 'ok' unless an owner explicitly sets it.
export function selectDispatch(guard, owner, confidence, minConfidence) {
  const approved = !!guard && (guard.verdict === 'ok' || guard.verdict === 'approved');
  // CONFIDENCE FLOOR (item-2 gate — fail-closed on the LIVE path only, DATA-tunable): when a positive
  // minConfidence is configured, a decision LIVE-sends only if its self-assessed confidence is a finite
  // number >= the floor; a low OR missing confidence falls to the SAFE draft (human review), never an
  // auto-send. minConfidence <= 0 / unset -> no floor (backward-compatible with the 2-arg call). This
  // NEVER affects the draft or none paths — the running draft flow is unchanged; it only tightens auto-send.
  const floorOn = Number.isFinite(minConfidence) && minConfidence > 0;
  const confOk = !floorOn || (Number.isFinite(Number(confidence)) && Number(confidence) >= minConfidence);
  const liveEligible = approved && confOk && !!owner && owner.owner_resolved === true
    && !!owner.resolved_owner_target && owner.needs_credential !== true && !!owner.send_payload_template;
  if (liveEligible) return { mode: 'live', target: owner.resolved_owner_target, template: owner.send_payload_template };
  if (owner && owner.draft_target && owner.draft_payload_template) return { mode: 'draft', target: owner.draft_target, template: owner.draft_payload_template };
  return { mode: 'none', target: null, template: null };
}
// Build an owner-shaped payload from a DATA template by substituting intent fields (generic, L090:
// a "$field" value is replaced by intent[field]; any other value is a literal). This keeps the sweep
// blind to each owner's payload shape — the shape is DATA on the owner-map row, not code.
// W1b (V14 fix): the payload-template primitive lives in ./lib/template.mjs (pure leaf, no I/O, no main()).
// Re-exported here so existing importers/tests keep resolving buildPayloadFromTemplate from this module.
export { buildPayloadFromTemplate } from './lib/template.mjs';
// DISPATCH: forward the drafted artifact to its owner via execute_definition (Envelope). Returns the
// owner's artifact ref (chunk_manifest_hash) when the process completes. This owns NO send logic — the
// owner materializes the draft; a later owner-approval + credential turns the draft into a live send.
async function dispatchToOwner(ownerTarget, payload, basis) {
  try {
    const r = await postTarget('slot::workflow', { operation: 'execute_definition', definition_id: ownerTarget, include_output: true, include_steps: false, input: payload }, basis, 10000);
    const out = r && r.output;
    const ref = (out && (out.chunk_manifest_hash || out.integrity_hash)) || null;
    const ok = !!(r && (r.status === 'completed' || ref));
    return { ok, ref };
  } catch { return { ok: false, ref: null }; }
}
// (2) GUARD: consult ai-action-guard's real limit+state DATA. Fail-closed: a state that is not an
// explicit ok/approved (e.g. "requires-owner-check") means the action CANNOT auto-execute -> the
// receipt is held as a draft for the owner. This enforces the outside-contact guardrail structurally.
export function resolveGuard(intent, limits, states) {
  const limit = resolveGuardLimit(intent, limits);
  if (!limit) return { verdict: 'no-limit', limit_ref: null, requires_owner: false };
  const suffix = String(limit.id).split(':').pop();
  const state = (Array.isArray(states) ? states : []).find((s) => s && String(s.id || '').endsWith(suffix)) || null;
  const verdict = (state && state.state) || 'no-state';
  return { verdict, limit_ref: limit.id, requires_owner: verdict !== 'ok' && verdict !== 'approved' };
}
async function writeBatch(writes, basis) { const j = await postTarget('engine.operation.label-addressed', { operation_label: 'engine.operation.write-batch', writes }, basis); return !!(j && (j.write_count || j.ok || j.status === 200 || j.writes_committed)); }
async function main() {
  if (!CARRIER_URL || !PARTITION_LABEL) { console.error(CARRIER_AND_PARTITION_REQUIRED); process.exit(1); }
  const basis = await fetchBasis();
  // SCALABLE selection (L063): a high-water `sweep-cursor` (newest run.id processed) bounds each tick to
  // NEW runs only, so a growing backlog of historical runs (e.g. 500+ advice runs) is NOT reprocessed
  // every tick (that O(runs) reprocessing timed out the 120s in-engine compute.process). Undispatched
  // drafts flagged `dispatch-retry` are also reprocessed (bounded set) so a failed materialize retries.
  const existingReceipts = await findKind('action-intent-receipt', basis);
  const retryRuns = new Set(existingReceipts.filter((p) => p.dispatch_status === 'dispatch-retry').map((p) => p.source_run).filter(Boolean));
  const cursorRec = (await findKind('sweep-cursor', basis))[0] || null;
  const cursor = (cursorRec && cursorRec.cursor) || '';
  // SWEEP_CAP bounds runs processed per tick so the in-engine compute.process (~120s wall) ALWAYS
  // completes and reaches the end-of-loop cursor write — a large cap (80) over a big backlog overran
  // the timeout and the cursor never advanced (deadlock, cont.197). Small cap drains a backlog across
  // ticks with guaranteed committed progress each tick.
  // (SWEEP_CAP + RETRY_CAP) × the 10s dispatch bound must stay under the 120s compute budget so EVERY tick
  // completes and reaches the cursor write even in the all-dispatch-timeout case ((6+4) × ~10s = 100s < 120s).
  // cont.225b: RETRY_CAP was the missing bound — an UNCAPPED retryList (11 dispatch-retry receipts, each a
  // 10s-bounded dispatch that times out because the draft materialize is ~50s under studio load) made
  // toProcess = fresh(8) + retry(11) = 19 dispatches ≈ 190s -> the tick STILL overran 120s even after the
  // per-dispatch bound. Bounding retries too (same pattern as SWEEP_CAP) makes every tick complete.
  const SWEEP_CAP = 6;
  const RETRY_CAP = 4;
  // NULL-RESULT GRACE (cont.198): a run whose AI-turn result is not readable is AMBIGUOUS — either the
  // producer result is permanently gone/rolled (OLD run → the cursor must advance PAST it or a dead zone
  // of gone results stalls the sweep forever) OR the AI turn simply has not finished yet (RECENT run →
  // must be retried next tick, NOT skipped, or its decision is lost). Disambiguate by age: a null older
  // than NULL_GRACE_MS is treated as permanently gone (advance past); a recent null is left for retry.
  const NULL_GRACE_MS = 15 * 60 * 1000;
  const nowMs = Date.now();
  const isPermanentlyGone = (runId) => { const t = Date.parse(runId); return Number.isFinite(t) && (nowMs - t) > NULL_GRACE_MS; };
  // Advance the high-water cursor past a fresh run that is DEFINITIVELY handled but wrote no receipt
  // (errored / advice-rejected / old-null). Persisted immediately so a mid-tick process kill keeps the
  // progress and the next tick resumes past the dead zone instead of re-stalling on it.
  const advancePast = async (runId) => { if (runId > cursor) await writeBatch([{ partition_label: PARTITION_LABEL, address_label: 'sweep-cursor', address_mode: 'identity_text', path_labels: ['current-item', 'sweep-cursor-index'], payload: { kind: 'sweep-cursor', id: 'sweep-cursor', cursor: runId } }], basis); };
  // capability_owner_map (DATA, plan §4): rows mapping capability-prefix -> real owner addresses.
  const ownerRows = (await findKind('action-intent-owner-map', basis)).flatMap((r) => Array.isArray(r.rows) ? r.rows : []);
  // Guard policy DATA read ONCE (not per run) — the ai-action-guard limits+states are shared across all
  // intents this tick, so reading them per run was O(runs) network round-trips that timed out the sweep.
  const guardLimits = await findKind('ai-guard-limit', basis);
  const guardStates = await findKind('ai-guard-state', basis);
  // CONFIDENCE FLOOR (DATA, item-2 gate): read once per tick; default 0 = no floor (unchanged behavior).
  // A `confidence-threshold` record { threshold: 0.5 } activates the fail-closed live-send confidence gate
  // in selectDispatch — a below-floor decision falls to the safe draft instead of auto-sending. Tunable in
  // pure DATA (Physics vs Society: the number is a Society preference, not a code constant).
  const confFloorRec = (await findKind('confidence-threshold', basis))[0] || null;
  const MIN_CONFIDENCE = confFloorRec && Number.isFinite(Number(confFloorRec.threshold)) ? Number(confFloorRec.threshold) : 0;
  // SCALE FIX (L063): drive off the SMALL operator-specific `produce-grounded-audit` kind (one record per
  // grounded heartbeat, carrying request_id = the producer result address) instead of the shared unbounded
  // `ai-execution-run` kind (4000+ records across ALL agents — codex, others — each with a large label).
  // Reading 4000+ heavy records every tick made the in-engine sweep unreliable under load; the audit kind is
  // tiny and exactly the operator's own decisions. request_id IS the run id (RESULT_PREFIX + request_id).
  const auditRuns = await findKind('produce-grounded-audit', basis);
  const runs = auditRuns.map((a) => ({ id: a.request_id, agent_ref: a.agent_ref })).filter((r) => typeof r.id === 'string');
  const isoRuns = runs.filter((p) => /^\d{4}-\d\d-\d\dT/.test(p.id) && (!AGENT_REF || String(p.agent_ref || '') === AGENT_REF));
  // Process NEW runs past the cursor (oldest-first, capped so one tick can't overrun the process timeout)
  // + any undispatched dispatch-retry runs (bounded). Advance the cursor to the newest NEW run processed.
  const freshRuns = isoRuns.filter((r) => r.id > cursor).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, SWEEP_CAP);
  const retryList = isoRuns.filter((r) => retryRuns.has(r.id) && r.id <= cursor).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, RETRY_CAP);
  const toProcess = freshRuns.concat(retryList);
  let receipts = 0, rejected = 0, skipped = 0, errored = 0, verifyFail = 0, dispatchedN = 0;
  for (const run of toProcess) {
   try {
    const isFresh = run.id > cursor;
    const result = await readResult(run.id, basis);
    // Null result: retry a RECENT run (AI turn not finished yet); advance past an OLD run whose result is
    // permanently gone so a dead zone of expired results can't stall the cursor forever (cont.198).
    if (!result) { if (isFresh && isPermanentlyGone(run.id)) { skipped++; await advancePast(run.id); } continue; }
    if (result.error_code != null) { errored++; if (isFresh) await advancePast(run.id); continue; } // producer error -> not a decision, definitively handled
    const item = (result.items && result.items[0]) || null;
    // (1) VALIDATE — fail-closed. Advice text (no action-intent object) -> NO record.
    const intent = parseActionIntent(item);
    if (!intent || intent.invalid) { rejected++; if (isFresh) await advancePast(run.id); continue; }
    const agentRef = run.agent_ref || AGENT_REF || '';
    const intentHash = hash12(JSON.stringify(intent));
    // Resolve the REAL dispatchable owner address for this capability (DATA map).
    const owner = resolveOwnerTarget(intent, ownerRows);
    // (2) GUARD — resolved from the once-read policy DATA (no per-run network calls). The effective
    // guard limit is DATA-driven per-capability: the intent's own guard_limit_ref wins, else the
    // owner-map row's guard_limit_ref, else the outside-contact default (fail-closed). This lets a
    // capability class be classified auto-safe (an ok-state limit) purely in DATA, no code change.
    const guard = resolveGuard({ ...intent, guard_limit_ref: intent.guard_limit_ref || owner.guard_limit_ref }, guardLimits, guardStates);
    // (3) RECEIPT — deterministic address (L063 idempotency): agent+capability+intent+source_run.
    const detKey = hash12(`${agentRef}|${intent.capability}|${intentHash}|${run.id}`);
    const receiptAddr = `action-intent-receipt::${detKey}`;
    // DISPATCH_OR_DRAFT: a requires-owner or credentialed action cannot LIVE-send, but its SAFE draft
    // (draft_target: e.g. publish-composer materialize-draft) can be materialized now via Envelope so the
    // artifact enters the real owner pipeline, pending only owner-approval + credential. When the owner-map
    // row carries a draft_payload_template we build the owner-shaped payload (DATA, generic) and dispatch.
    // A draft materializes whenever a draft_target + template exist — INDEPENDENT of whether a live-send
    // owner (owner_target) exists. This is what closes the "no clean send owner" capabilities
    // (offer/pricing/email): they have no owner_target to send to, but their decision still becomes a real
    // materialized safe-draft artifact instead of a stranded note (The owner's DECIDE->ACT correction).
    // DISPATCH_OR_LIVE_OR_DRAFT (selectDispatch, DATA-driven): a positively-guard-approved intent with a
    // resolved send owner + no credential gap + a send_payload_template LIVE-sends to the real owner;
    // otherwise its SAFE draft is materialized. Either way the artifact enters a real owner pipeline via
    // Envelope (no god package). External-contact capabilities stay draft-gated until their guard-state
    // is 'ok' AND an owner supplies a send_payload_template — both owner-controlled DATA.
    // DECOUPLED ACT (cont227): the sweep is now pure DECIDE — it does NOT synchronously materialize the
    // draft here. That owner dispatch is a ~50s compute.process spawn under studio load; blocking on it made
    // the sweep take ~65s, LAG the ~20s clock, and starve the workflow slot against the codex produce turn
    // (autonomous cursor sat ~2min behind, cont227). The sweep writes the receipt as dispatch_status:'pending'
    // carrying the resolved plan (mode+target); the SEPARATE throttled `materialize-pending-once` pass (also
    // clock::tick-driven) dispatches the draft/owner a few at a time and updates the receipt. DECIDE stays
    // fast (no per-run 50s block) so the sweep keeps up with the clock; ACT drains at the machine's pace.
    const plan = selectDispatch(guard, owner, intent.confidence, MIN_CONFIDENCE);
    const dispatched = false, dispatchRef = null, dispatchMode = 'none';
    const dispatchStatus = plan.mode === 'none' ? 'no-dispatch-target' : 'pending';
    const phase = 'draft';
    const holdReason = guard.requires_owner ? `guard:${guard.verdict}` : (intent.status === 'ready' ? 'awaiting-credential' : 'intent-draft');
    // ARTIFACT-ONCE (WS3b-T4): store the full artifact once by content hash; every wrapper carries a ref.
    // The receipt drops inline `artifact` — `materialize-pending-once` resolves the ref at ACT time to
    // build the send payload (a single resolve at dispatch, never a persisted copy).
    const artifactRef = buildArtifactRef(intent.artifact, run.id);
    const artifactBlobWrite = buildArtifactBlobWrite(intent.artifact, run.id, PARTITION_LABEL);
    const receipt = {
      kind: 'action-intent-receipt', id: receiptAddr, source_run: run.id, agent_ref: agentRef,
      capability: intent.capability, owner_target: intent.owner_target, audience: intent.audience ?? null,
      artifact_ref: artifactRef, goal_ancestry: intent.goal_ancestry, expected_metric: intent.expected_metric ?? null,
      success_threshold: intent.success_threshold ?? null, grounding_citation: intent.grounding_citation ?? null,
      confidence: intent.confidence ?? null, confidence_floor: MIN_CONFIDENCE, intent_hash: intentHash,
      guard_verdict: guard.verdict, guard_limit_ref: guard.limit_ref, requires_owner_check: guard.requires_owner,
      resolved_owner_target: owner.resolved_owner_target, draft_target: owner.draft_target,
      needs_credential: owner.needs_credential, owner_resolved: owner.owner_resolved,
      phase, dispatched, dispatch_status: dispatchStatus, dispatch_mode: dispatchMode, dispatch_ref: dispatchRef, hold_reason: holdReason,
      // resolved dispatch plan carried on the receipt so materialize-pending-once can ACT from the receipt
      // alone (mode + target); the payload TEMPLATE it re-reads from the owner-map by capability (DATA).
      dispatch_plan_mode: plan.mode, dispatch_plan_target: plan.target,
      status: 'receipt-drafted', decided_at: run.id, model_provenance_ref: (item && item.model_provenance_ref) || null,
    };
    // Keep an agent-decision (board) + ai-memory-record (continuity) — now GATED on a valid intent,
    // each carrying the receipt ref. Advice never reaches these (rejected above).
    // The board record carries the REASONING (goal_ancestry, grounding_citation, confidence,
    // audience, metric) — not just the artifact — so the review surface shows WHY a decision serves
    // the mission + what playbook grounds it, making it genuinely reviewable/approvable (L114/L116).
    // All fields already exist on `intent`; this is projection, no new computation.
    const decision = { kind: 'agent-decision', id: `agent-decision::${detKey}`, artifact_ref: artifactRef, capability: intent.capability, owner_target: intent.owner_target, receipt_ref: receiptAddr, phase, agent_ref: agentRef, source_run: run.id, decided_at: run.id, status: 'receipt-drafted', guard_verdict: guard.verdict, goal_ancestry: intent.goal_ancestry ?? null, grounding_citation: intent.grounding_citation ?? null, confidence: intent.confidence ?? null, audience: intent.audience ?? null, expected_metric: intent.expected_metric ?? null, success_threshold: intent.success_threshold ?? null };
    // ai-memory-record: `content` is the contract-required field (ai-memory record-contract
    // required_fields:[id, content]); `body` kept as a legacy mirror so any reader of the old shape
    // still works. Serves ai-memory in ITS contract language (L098).
    const memoryText = `[${intent.capability}] ${String(intent.artifact).slice(0, 400)}`;
    const memory = { kind: 'ai-memory-record', id: `ai-memory-record::${detKey}`, content: memoryText, body: memoryText, agent_ref: agentRef, subject_ref: agentRef, label: `action-intent @ ${run.id}`, memory_type: 'decision', importance_score: 1, receipt_ref: receiptAddr, source_run: run.id };
    const writes = [
      // Canonical artifact stored once by content hash (idempotent — identical text -> same address), in
      // the SAME batch as the wrappers that reference it, so no wrapper ever points at a missing blob.
      artifactBlobWrite,
      { partition_label: PARTITION_LABEL, address_label: receiptAddr, address_mode: 'identity_text', path_labels: ['current-item', 'action-intent-receipt-index'], payload: receipt },
      { partition_label: PARTITION_LABEL, address_label: `agent-decision::${detKey}`, address_mode: 'identity_text', path_labels: ['current-item', 'agent-decision-index'], payload: decision },
      // L126 exhaust-off #5: ai-memory-record writes to its dedicated ai-memory-index list-path.
      // Readers are already BOTH-PATHS (findKind maps here + produce-grounded) and the agents-hub
      // registry-feed unions ai-memory-index, so no reader goes blind at any deploy ordering.
      { partition_label: PARTITION_LABEL, address_label: `ai-memory-record::${detKey}`, address_mode: 'identity_text', path_labels: ['current-item', 'ai-memory-index'], payload: memory },
    ];
    // INCREMENTAL CURSOR (durability, L063): fold the `sweep-cursor` into the SAME batch as each accepted
    // FRESH run's receipt. Runs process oldest-first, so cursor=run.id covers all PRECEDING runs (accepted
    // + rejected). If a LATER run's write bounces the engine mid-sweep, committed progress survives — the
    // cursor is already at the last successful accept, so the next tick resumes there instead of
    // reprocessing the whole growing window. Fixes the "cursor-written-once-at-end loses all progress on a
    // mid-run write-bounce" flaw (cont.161). Only advances (fresh runs are > cursor; retry runs are not).
    if (run.id > cursor) {
      writes.push({ partition_label: PARTITION_LABEL, address_label: 'sweep-cursor', address_mode: 'identity_text', path_labels: ['current-item', 'sweep-cursor-index'], payload: { kind: 'sweep-cursor', id: 'sweep-cursor', cursor: run.id } });
    }
    const ok = await writeBatch(writes, basis);
    if (!ok) { errored++; continue; }
    // (4) READBACK_VERIFY — read the receipt back; verify intent_hash binds. Only then is it terminal.
    const back = await readAddr(receiptAddr, basis);
    if (back && back.intent_hash === intentHash) receipts++; else verifyFail++;
    if (dispatched) dispatchedN++;
   } catch (e) {
    // PER-RUN ISOLATION (cont.225): a single malformed producer result can NEVER stall the whole tick.
    // Count it errored and, if it is an OLD fresh run, advance the cursor PAST it (a recent one is left
    // for retry in case the throw was transient). Mirrors the null-result grace — no poison-run stall.
    errored++; if (run.id > cursor && isPermanentlyGone(run.id)) { try { await advancePast(run.id); } catch {} }
   }
  }
  // Advance the high-water cursor to the newest NEW run processed this tick (bounded backlog drain).
  const newCursor = freshRuns.reduce((m, r) => (r.id > m ? r.id : m), cursor);
  if (newCursor !== cursor) {
    await writeBatch([{ partition_label: PARTITION_LABEL, address_label: 'sweep-cursor', address_mode: 'identity_text', path_labels: ['current-item', 'sweep-cursor-index'], payload: { kind: 'sweep-cursor', id: 'sweep-cursor', cursor: newCursor } }], basis);
  }
  console.log(`[receipt-gate] total_runs=${isoRuns.length} processed=${toProcess.length} receipts=${receipts} dispatched=${dispatchedN} rejected_advice=${rejected} errored=${errored} verify_fail=${verifyFail} cursor=${newCursor}`);
}
// Run only as the process entry (env set in prod); a test importing this module skips main().
if (CARRIER_URL) { main().catch((e) => { console.error('Fatal:', e); process.exit(1); }); }
