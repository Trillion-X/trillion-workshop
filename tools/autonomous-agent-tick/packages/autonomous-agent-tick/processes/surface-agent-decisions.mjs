#!/usr/bin/env node
/**
 * surface-agent-decisions.mjs
 *
 * Layer 2-4 of the autonomous loop (dispatch/surface). A standing process
 * (compute.process_session, mirrors notice-when-something-shows-up/do-work/emit-arrival-fact.mjs) that
 * turns the ai-records-producer's label-hash decision results — which are NOT
 * findable and NOT trigger-fireable — into GUARDED, DEDUPLICATED, findable
 * `agent-decision` published-records that a board/projection can show and that
 * downstream triggers can react to.
 *
 * Per tick:
 *   1. find recent ai-execution-run records (identity_text, findable) -> the
 *      request_ids (iso timestamps) of the autonomous decisions.
 *   2. read each result::<iso> (label-hash) via engine.operation.read-current.
 *   3. GUARD (fail-closed, Layer 2-3): skip if error_code != null or no
 *      model_provenance_ref (no silent wrong/ungrounded decisions surfaced).
 *   4. DEDUP: skip decisions whose text hash was already surfaced.
 *   5. WRITE agent-decision (identity_text, findable) at agent-decision::<hash>.
 *
 * This package OWNS no AI/board logic — it is a thin ETL over the generic
 * producer's output; the AI turn stays in ai-records-producer, projection stays
 * in visual-database. No god package.
 *
 * Environment:
 *   BITFIELD_TARGET_CARRIER_URL  : the running shell HTTP endpoint
 *   BITFIELD_TARGET_CARRIER_URL_FILE: the path the runtime publishes that address into
 *   BITFIELD_DISPATCH_PARTITION  : partition to read/write (runtime-partition)
 *   BITFIELD_DISPATCH_INTERVAL_SECONDS : poll interval (default 60)
 *   BITFIELD_DISPATCH_AGENT_REF  : only surface runs for this agent (optional filter)
 *   BITFIELD_DISPATCH_RESULT_PREFIX : result address prefix (default package::ai-records-producer::result::)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
// ARTIFACT-ONCE-BY-HASH (WS3b-T4): the full decision text is stored ONCE in the content-addressed artifact
// store; agent-decision carries a small ref + preview instead of an inline `decision_text` copy.
import { buildArtifactRef, buildArtifactBlobWrite } from './lib/artifact-store.mjs';
import { resolveCarrier, resolvePartition, CARRIER_AND_PARTITION_REQUIRED } from './lib/carrier.mjs';

const INTERVAL_SECONDS = parseInt(process.env.BITFIELD_DISPATCH_INTERVAL_SECONDS || '60', 10);
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
const STATE_FILE = path.join(process.cwd(), '.surface-agent-decisions-state.json');

if (!CARRIER_URL || !PARTITION_LABEL) {
  console.error(CARRIER_AND_PARTITION_REQUIRED);
  process.exit(1);
}

function loadState() {
  if (existsSync(STATE_FILE)) {
    try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch (e) { /* fresh */ }
  }
  return { seenIsos: [], seenHashes: [], basis: null };
}
function saveState(state) { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

// Deterministic small string hash (dedup key; no crypto dep).
function hashText(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function fetchBasis() {
  try {
    const r = await fetch(new URL('/boot', CARRIER_URL).toString(), { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error(`/boot ${r.status}`);
    const boot = await r.json();
    const basis = Array.isArray(boot) && boot[0]?.running_command_list_basis;
    if (typeof basis !== 'string' || !basis) throw new Error('no basis');
    return basis;
  } catch (e) { console.error('fetchBasis failed:', e.message); return null; }
}

async function postTarget(target, body, basis) {
  const url = new URL(`/target/${target}`, CARRIER_URL);
  const r = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bitfield-Running-Command-List-Basis': basis || '' },
    body: JSON.stringify(body),
  });
  if (r.status === 428) return { staleBasis: true };
  if (!r.ok) throw new Error(`${target} ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const txt = await r.text();
  try { return { ok: JSON.parse(txt) }; } catch { return { ok: txt }; }
}

async function findExecutionRuns(basis) {
  const q = { operation: 'find-current-items', in: 'ai-execution-run-index', where: { all: [{ field: 'kind', in: ['ai-execution-run'] }] } };
  const res = await postTarget('slot::find-current-items', q, basis);
  if (res.staleBasis) return null;
  const d = res.ok; const items = (d && (d.items || d.records)) || [];
  return items.map((x) => (x.payload || x)).filter((p) => p && typeof p.id === 'string');
}

async function readResult(iso, basis) {
  const body = { operation_label: 'engine.operation.read-current', partition_label: PARTITION_LABEL, address_label: RESULT_PREFIX + iso, address_mode: 'label-hash' };
  const res = await postTarget('engine.operation.label-addressed', body, basis);
  if (res.staleBasis) return null;
  const p = res.ok && (res.ok.payload || res.ok.value || res.ok);
  return p || null;
}

async function writeDecision(hash, payload, basis, extraWrites = []) {
  const body = {
    operation_label: 'engine.operation.write-batch',
    writes: [
      // The canonical artifact blob (stored once by content hash) is written in the SAME batch as its
      // referencing decision — so a decision never persists a ref to a blob that isn't there.
      ...extraWrites,
      {
        partition_label: PARTITION_LABEL,
        address_label: `agent-decision::${hash}`,
        address_mode: 'identity_text',
        path_labels: ['current-item', 'agent-decision-index'],
        payload,
      },
    ],
  };
  const res = await postTarget('engine.operation.label-addressed', body, basis);
  return !res.staleBasis;
}

async function sweep(state) {
  if (!state.basis) { state.basis = await fetchBasis(); if (!state.basis) return; }
  let runs = await findExecutionRuns(state.basis);
  if (runs === null) { state.basis = await fetchBasis(); return; }
  // Only iso-keyed runs (the autonomous decisions); optional agent filter.
  const isoRuns = runs.filter((p) => /^\d{4}-\d\d-\d\dT/.test(p.id) && (!AGENT_REF || String(p.agent_ref || '') === AGENT_REF));
  const seenIso = new Set(state.seenIsos);
  const seenHash = new Set(state.seenHashes);
  let surfaced = 0, guarded = 0, deduped = 0;
  for (const run of isoRuns) {
    if (seenIso.has(run.id)) continue;
    const result = await readResult(run.id, state.basis);
    seenIso.add(run.id);
    if (!result) continue;
    // GUARD (Layer 2-3, fail-closed): grounded + no error only.
    const item = (result.items && result.items[0]) || null;
    const text = item && String(item.text || '').trim();
    const provenance = item && item.model_provenance_ref;
    if (result.error_code != null || !text || !provenance) { guarded++; continue; }
    const h = hashText(text);
    if (seenHash.has(h)) { deduped++; continue; }
    seenHash.add(h);
    // ARTIFACT-ONCE (WS3b-T4): store the full text once by content hash; the decision carries a ref +
    // bounded preview (board renders the preview; a detail view resolves store_address for the full text).
    const artifactRef = buildArtifactRef(text, run.id);
    const blobWrite = buildArtifactBlobWrite(text, run.id, PARTITION_LABEL);
    const ok = await writeDecision(h, {
      kind: 'agent-decision', id: `agent-decision::${h}`,
      artifact_ref: artifactRef, model_provenance_ref: provenance,
      agent_ref: run.agent_ref || AGENT_REF || '', source_run: run.id,
      decided_at: run.id, status: 'surfaced', guard: 'grounded+no-error',
    }, state.basis, [blobWrite]);
    if (ok) surfaced++;
  }
  state.seenIsos = [...seenIso].slice(-500);
  state.seenHashes = [...seenHash].slice(-500);
  console.log(`[${new Date().toISOString()}] sweep: runs=${isoRuns.length} surfaced=${surfaced} guarded_out=${guarded} deduped=${deduped}`);
}

// ONE sweep, then exit. WHEN this runs again belongs to the installing DATA, not to this process.
//
// This used to re-arm itself on a timer every INTERVAL_SECONDS, which made the process a second
// owner of scheduling: changing the cadence meant restarting a long-lived process instead of
// editing a trigger. The clock waiter in `notice-when-something-shows-up` emits `clock::tick`, a trigger-rule matches it, and the
// installing DATA dispatches this same process once per tick.
//
// Per-tick invocation is safe here because the sweep was already idempotent across restarts: state
// is loaded from disk at the top and saved at the bottom, and the seen-ISO and seen-hash lists it
// persists are exactly the dedupe the timer version relied on between iterations. Nothing lived
// only in memory between ticks.
//
// INTERVAL_SECONDS is kept because it is still read for the startup log and by the installer that
// sets the trigger cadence, so the declared value and the real one stay one value.
async function main() {
  const state = loadState();
  console.log(`surface-agent-decisions sweep (declared cadence=${INTERVAL_SECONDS}s, owned by the installer trigger; partition=${PARTITION_LABEL})`);
  await sweep(state);
  saveState(state);
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
