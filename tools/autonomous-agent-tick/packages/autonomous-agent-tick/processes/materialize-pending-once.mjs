/**
 * materialize-pending-once.mjs — THROTTLED ACT pass (cont227 decouple, L063).
 *
 * The sweep (DECIDE) now writes each valid action-intent as an action-intent-receipt with
 * dispatch_status:'pending' and does NOT block on the slow owner/draft materialize. THIS pass does the ACT:
 * fired per clock::tick, it reads the oldest few 'pending'/'dispatch-retry' receipts and dispatches each
 * one's draft/owner (the owner materialize is a ~50s compute.process spawn under studio load), then updates
 * the receipt. Bounded to MATERIALIZE_CAP per tick so this one-shot always completes and never overlaps a
 * long produce/codex turn on the workflow slot. DECIDE stays fast (sweep no longer blocks); ACT drains here
 * at the machine's pace. No god package: the effect owners (publish-composer / content-distribution /
 * timed-action) still do the work; this only forwards the receipt's resolved plan via Envelope.
 *
 * Env: BITFIELD_TARGET_CARRIER_URL (or BITFIELD_TARGET_CARRIER_URL_FILE, the path the runtime publishes its address into), BITFIELD_DISPATCH_PARTITION, BITFIELD_DISPATCH_AGENT_REF (optional).
 */
// W1b (V14 fix): the payload-template primitive now lives in ./lib/template.mjs — a PURE leaf with no main()
// side effect, imported by BOTH this file and sweep-decisions-once.mjs (one SSOT, no duplication). The old
// reason for inlining (importing sweep would trigger its env-guarded main()) is gone: lib/template.mjs is
// pure. Re-exported so this module's test keeps importing buildPayloadFromTemplate from here.
export { buildPayloadFromTemplate } from './lib/template.mjs';
// ARTIFACT-ONCE-BY-HASH (WS3b-T4): receipts carry `artifact_ref`, not an inline `artifact`. At ACT time we
// resolve the ref ONCE (read the content-addressed blob) to build the owner's send payload — fail-closed:
// a ref that doesn't resolve/verify means the receipt is skipped, never sent with wrong/absent bytes.
import { extractResolvedArtifact } from './lib/artifact-store.mjs';
import { resolveCarrier, resolvePartition, CARRIER_AND_PARTITION_REQUIRED } from './lib/carrier.mjs';
// PURE throttled ACT selection (unit-tested): the oldest pending/dispatch-retry receipts that carry a real
// dispatch plan (a target AND a mode that is not 'none'), scoped to this agent, capped so the tick always
// completes. Fail-closed: a receipt with no plan / mode 'none' / wrong status / wrong agent is NEVER selected
// for dispatch. This is the gate on WHICH receipts get acted on (incl. the LIVE send path), so a regression
// here could dispatch the wrong receipt or an unplanned one.
export function selectPendingReceipts(receipts, agentRef, cap) {
  return (receipts || [])
    .filter((r) => r && (r.dispatch_status === 'pending' || r.dispatch_status === 'dispatch-retry') && r.dispatch_plan_target && r.dispatch_plan_mode && r.dispatch_plan_mode !== 'none')
    .filter((r) => !agentRef || String(r.agent_ref || '') === agentRef)
    .sort((a, b) => (String(a.source_run) < String(b.source_run) ? -1 : 1))
    .slice(0, Number.isFinite(cap) && cap >= 0 ? cap : (receipts || []).length);
}
// A supervisor entry is written once and frozen; a runtime that picks its port at
// startup has an address that changes every time it starts. So the supervisor is given
// the PATH of the file the runtime publishes its address into, which does not change,
// rather than the address, which does. Nothing is searched for: the path arrives as DATA
// exactly as the URL does. The chain now lives in ./lib/carrier.mjs, mounted beside this file; the
// claim that a sibling import could not resolve was stale, and this file was already importing
// ./lib/artifact-store.mjs while asserting it.
const CARRIER_URL = resolveCarrier();
const PARTITION_LABEL = resolvePartition();
const AGENT_REF = process.env.BITFIELD_DISPATCH_AGENT_REF || '';
// DRAFT vs LIVE dispatch cost (cont362 root-cause, L055/L063):
// - DRAFT mode: the drafted artifact is ALREADY materialized in rec.artifact. The old draft owner def
//   (publish-composer-materialize-draft) only RE-STORED the same bytes via a ~74s compute.process spawn
//   (pure OS-subprocess overhead under the studio CAS — it grew past the old 54s bound on 2026-07-07 and
//   stalled the whole ACT pass for 2 days). Drafts are now marked draft-dispatched DIRECTLY, no owner call,
//   instant. So MATERIALIZE_CAP can be large — drafts are ~free (one write-batch each).
// - LIVE mode: a real external effect (send/post/schedule) genuinely dispatched to the owner package via a
//   slow compute.process — bounded per run by LIVE_DISPATCH_CAP so LIVE_DISPATCH_CAP × DISPATCH_TIMEOUT_MS
//   stays under the 120s def budget: 2 × 54s = 108s < 120s. LIVE stays human-gated (dispatch_plan_mode=live).
const MATERIALIZE_CAP = 60;
const LIVE_DISPATCH_CAP = 2;
const DISPATCH_TIMEOUT_MS = 54000;

// Validate config only when invoked as the process entry (CARRIER set in prod); a test importing this
// module for the pure exports skips both this exit and main().
if (CARRIER_URL && !PARTITION_LABEL) { console.error(CARRIER_AND_PARTITION_REQUIRED); process.exit(1); }

async function fetchBasis() { const r = await fetch(new URL('/boot', CARRIER_URL), { headers: { 'Cache-Control': 'no-cache' } }); const j = await r.json(); return j[0].running_command_list_basis; }
async function postTarget(target, body, basis, timeoutMs = 25000) { const ac = new AbortController(); const to = setTimeout(() => ac.abort(), timeoutMs); try { const r = await fetch(new URL('/target/' + encodeURIComponent(target), CARRIER_URL), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bitfield-Running-Command-List-Basis': basis }, body: JSON.stringify(body), signal: ac.signal }); const x = await r.text(); try { return JSON.parse(x); } catch { return null; } } catch { return null; } finally { clearTimeout(to); } }
// L126 exhaust-off: same KIND_LIST_PATH choke point as sweep-decisions-once.mjs — action-intent-receipt
// moved onto its own action-intent-receipt-index list-path; every other kind (action-intent-owner-map, ...)
// stays on published-record. Add ONE row per future exhaust-off.
const KIND_LIST_PATH = { 'action-intent-receipt': 'action-intent-receipt-index' };
// BOTH-PATHS ROBUST (deploy-safe, self-healing — see sweep-decisions-once.mjs): read a mapped kind from BOTH
// its index path AND published-record, dedup by id, so the reader is correct whether or not existing records
// have been backfilled off published-record yet. Converges to index-only after backfill with no code change.
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
async function writeBatch(writes, basis) { const j = await postTarget('engine.operation.label-addressed', { operation_label: 'engine.operation.write-batch', writes }, basis); return !!(j && (j.write_count || j.ok || j.status === 200 || j.writes_committed)); }
// A DISPATCHER NAMES ITSELF. The owner's payload is built from its own send_payload_template, which
// substitutes fields of the INTENT, so it speaks the model's vocabulary. A partition is not the model's
// to name and never appears there, so before this the one owner that needed it froze a literal in its
// manifest env and minted records into an app nothing owns. The trigger-dispatched siblings already
// receive this exact field, `input.partition`, bound from `change.properties.runtime_context.partition`,
// so this makes the process-dispatch route carry what the trigger route always carried rather than
// inventing a shape. Stamped for EVERY owner, not for the row that needed it: an owner that ignores it
// is unaffected (no schema in this set declares additionalProperties), and the next owner to need it
// binds it with no edit here. The template wins on a key collision, because the owner's DATA outranks
// ambient wiring. PARTITION_LABEL is non-null by the fail-closed check at module scope.
export function stampDispatcherIdentity(payload, partitionLabel) {
  return { partition: partitionLabel, ...(payload && typeof payload === 'object' ? payload : {}) };
}
// Forward the receipt's drafted artifact to its owner via execute_definition (bounded). Returns owner ref.
async function dispatchToOwner(ownerTarget, payload, basis) { const r = await postTarget('slot::workflow', { operation: 'execute_definition', definition_id: ownerTarget, include_output: true, include_steps: false, input: stampDispatcherIdentity(payload, PARTITION_LABEL) }, basis, DISPATCH_TIMEOUT_MS); const out = r && r.output; const ref = (out && (out.chunk_manifest_hash || out.integrity_hash)) || null; const ok = !!(r && (r.status === 'completed' || ref)); return { ok, ref }; }
// Resolve a receipt's artifact_ref to its full text by reading the content-addressed blob (WS3b-T4).
// Returns null on any failure (missing ref, missing blob, hash mismatch) so callers fail closed.
async function resolveArtifactText(ref, basis) {
  if (!ref || !ref.store_address) return null;
  const j = await postTarget('engine.operation.label-addressed', { operation_label: 'engine.operation.read-current', partition_label: PARTITION_LABEL, address_label: ref.store_address, address_mode: 'identity_text' }, basis);
  if (!j || j.found === false) return null;
  const p = j.payload ?? j.value ?? j.ok?.payload ?? j.ok?.value ?? j.ok ?? null;
  return extractResolvedArtifact(ref, p && typeof p === 'object' ? p : {});
}

async function main() {
  const basis = await fetchBasis();
  const ownerRows = (await findKind('action-intent-owner-map', basis)).flatMap((r) => Array.isArray(r.rows) ? r.rows : []);
  const receipts = await findKind('action-intent-receipt', basis);
  // Oldest pending/retry receipts first (source_run is the ISO run id), capped so the tick always completes.
  const pending = selectPendingReceipts(receipts, AGENT_REF, MATERIALIZE_CAP);
  let dispatched = 0, retry = 0, skipped = 0, live = 0;
  for (const rec of pending) {
    try {
      // Re-read the owner-map row for this capability to get the payload TEMPLATE (DATA, generic).
      const row = ownerRows.find((o) => o.match_prefix && String(rec.capability || '').startsWith(o.match_prefix));
      let d;
      if (rec.dispatch_plan_mode === 'live') {
        // LIVE: a real external effect — dispatch to the owner package (content-distribution/timed-action).
        // Bounded per run (slow compute.process spawn); respect the def budget.
        if (live >= LIVE_DISPATCH_CAP) break;
        live++;
        const template = row && row.send_payload_template;
        if (!template) { skipped++; continue; }
        // WS3b-T4: resolve the artifact_ref to full text once, here, to build the send payload. Fail-closed:
        // if the receipt has a ref that won't resolve/verify, skip it rather than send absent/wrong bytes.
        const artifactText = await resolveArtifactText(rec.artifact_ref, basis);
        if (artifactText == null) { skipped++; continue; }
        const payload = buildPayloadFromTemplate(template, { ...rec, artifact: artifactText }); // template reads .artifact
        d = await dispatchToOwner(rec.dispatch_plan_target, payload, basis);
      } else {
        // DRAFT: the artifact is stored once by content hash and referenced by rec.artifact_ref (the sweep
        // wrote both in one batch). Calling the draft owner def only re-stores the same bytes via a ~74s
        // subprocess — pure overhead that stalled the ACT pass. Mark draft-dispatched DIRECTLY: instant, no
        // subprocess. A draft reviewer resolves rec.artifact_ref for the full text. Fail-closed if no ref.
        d = { ok: !!(rec.artifact_ref && rec.artifact_ref.store_address), ref: null };
        if (!d.ok) { skipped++; continue; }
      }
      const okStatus = rec.dispatch_plan_mode === 'live' ? 'live-sent' : 'draft-dispatched';
      const okPhase = rec.dispatch_plan_mode === 'live' ? 'acted' : 'draft-dispatched';
      const upd = { ...rec, dispatched: !!d.ok, dispatch_status: d.ok ? okStatus : 'dispatch-retry', dispatch_mode: d.ok ? rec.dispatch_plan_mode : 'none', dispatch_ref: d.ref || null, phase: d.ok ? okPhase : 'draft' };
      const receiptAddr = String(rec.id); // id is `action-intent-receipt::<detKey>`
      await writeBatch([
        { partition_label: PARTITION_LABEL, address_label: receiptAddr, address_mode: 'identity_text', path_labels: ['current-item', 'action-intent-receipt-index'], payload: upd },
      ], basis);
      if (d.ok) dispatched++; else retry++;
    } catch (e) { retry++; }
  }
  console.log(`[materialize-pending] candidates=${pending.length} dispatched=${dispatched} retry=${retry} skipped=${skipped}`);
}
if (CARRIER_URL) { main().catch((e) => { console.error('Fatal:', e); process.exit(1); }); }

// safe-deploy-path proof via byte-writer (cont.242) — no behavior change
