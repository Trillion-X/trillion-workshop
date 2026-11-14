#!/usr/bin/env node
// packages/ai-cli-launch-adapters/do-work/pause-outcome-contract.mjs
//
// =============================================================================
// PURPOSE: the REAL operator-Stop pause of the L168 outcome contracts (T8)
// =============================================================================
//
// Fires from the T8 trigger (trigger:harness.stop-on-stop-requested) when an
// operator clicks the Stop control (session-stop-requested). Reads the caller-selected
// LIVE outcome-continuation-contract records via the admitted find-current-items
// owner op and emits ONE real "harness-stop-pause" receipt naming the open
// contracts it pauses + the operator reason. Both continuation owners
// (continue-outcome and dispatch-harness-session) read live pause receipts and
// exclude those exact contracts before any replacement session can dispatch.
//
// Uses the same co-mounted running-app request source as
// continue-outcome.mjs / emit-session-event.mjs (no cross-package import).
// NEVER crashes the launch (best-effort; logs + exits 0).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function nonEmpty(v) { const t = typeof v === 'string' ? v.trim() : ''; return t || null; }
function readArg(args, name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? nonEmpty(args[index + 1]) : null;
}

// Caller-selected running-app target resolution. The workflow mounts the shared
// request source beside this leaf instead of importing across package paths.
export function resolveTarget(env = process.env) {
  const url = nonEmpty(env.BITFIELD_SESSION_EVENT_SHELL_URL) ?? nonEmpty(env.BITFIELD_SHELL_URL) ?? nonEmpty(env.BITFIELD_TARGET_CARRIER_URL)
    ?? (nonEmpty(env.BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS) ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(env.BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS) ? env.BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS : `http://${env.BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS}`) : null)
    ?? (nonEmpty(env.PORT) ? `http://127.0.0.1:${nonEmpty(env.PORT)}` : null);
  const partition = nonEmpty(env.BITFIELD_SESSION_EVENT_PARTITION) ?? nonEmpty(env.BITFIELD_PARTITION);
  return url && partition ? { url, partition } : null;
}

function runningAppRequests() {
  return import('./send-requests-to-running-app.mjs');
}

async function resolveRunningAppRequests(override = null) {
  let requests = override ?? await runningAppRequests();
  if (typeof requests === 'function') requests = await requests();
  return requests;
}

/**
 * PURE: compute the operator-stop pause receipt from live DATA. Names the open
 * (non-terminal) contracts this pause covers so the never-stop loop honors it.
 * Scoped to `sessionRef` when given (the stopped session's contracts), else all.
 */
export function computePauseReceipt({ contracts, contractRef, sessionRef, source, ts }) {
  const TERMINAL = new Set(['ACHIEVED', 'KILLED', 'SUPERSEDED']);
  const scoped = contracts.filter((c) => {
    if (TERMINAL.has(String(c.status || '').toUpperCase())) return false;
    if (contractRef) return String(c.id ?? c.address ?? '') === String(contractRef);
    if (!sessionRef) return true;
    return String(c.session_ref ?? c.session_id ?? '') === String(sessionRef);
  });
  return {
    kind: 'harness-stop-pause', schema: 'ai-orchestra.outcome-continuation-pause/live-v1',
    paused_at: ts, contract_ref: contractRef ?? null, session_ref: sessionRef ?? null, reason: source ?? 'operator-stop',
    paused_contract_count: scoped.length,
    paused_contracts: scoped.map((c) => ({ id: c.id ?? c.address ?? null, outcome: nonEmpty(c.observable_outcome) ?? null, prior_status: c.status ?? null })),
    requested_status: 'PAUSED',
    honest_note: scoped.length > 0
      ? `operator stop pauses ${scoped.length} open outcome-continuation contract(s); never-stop must not re-fire until resumed`
      : `operator stop recorded; no open outcome-continuation contracts to pause in this partition (${contractRef ? `contract ${contractRef}` : sessionRef ? `session ${sessionRef}` : 'all sessions'})`,
    source: 'live find-current-items over outcome-continuation-contract',
  };
}

export async function pauseOutcomeContract(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((m) => console.error(m));
  const contractRef = nonEmpty(options.contractRef) ?? nonEmpty(env.BITFIELD_STOP_CONTRACT_REF);
  const sessionRef = nonEmpty(options.sessionRef) ?? nonEmpty(env.BITFIELD_STOP_SESSION_REF);
  const source = nonEmpty(options.source) ?? nonEmpty(env.BITFIELD_STOP_SOURCE) ?? 'operator-stop';
  const target = options.target ?? resolveTarget(env);
  const requestsOverride = options.runningAppRequests ?? null;
  if (!target?.url) { log('[harness-pause] no engine target; skipping (launch continues)'); return { ok: false, reason: 'no-target' }; }
  try {
    const requests = await resolveRunningAppRequests(requestsOverride);
    const session = await requests.startRunningAppSession({ url: target.url, fetchImpl });
    const rows = await requests.findCurrentItems(session, 'published-record', { all: [{ field: 'kind', eq: 'outcome-continuation-contract' }] }, { fetchImpl });
    const contracts = rows.map((row) => row?.payload ?? row).filter(Boolean);
    const ts = new Date().toISOString();
    const receipt = computePauseReceipt({ contracts, contractRef, sessionRef, source, ts });
    // emit to stdout so an engine-driven compute.process step can capture + persist
    // it (captured_fds) even where the sandbox blocks the loopback self-write.
    if (options.emitStdout !== false) process.stdout.write(JSON.stringify(receipt));
    // capture mode: the workflow-def persist step is the single writer; skip self-write.
    if (nonEmpty(env.BITFIELD_HARNESS_CAPTURE_MODE)) return { ok: true, captured: true, receipt };
    const address = `package::ai-cli-launch-adapters::harness-stop-pause::${contractRef ?? sessionRef ?? 'all'}::${createHash('sha256').update(ts).digest('hex').slice(0, 12)}`;
    await requests.writeRecords(session, [{ partition_label: target.partition, address_label: address, address_mode: 'identity_text', path_labels: ['current-item', 'published-record'], payload: receipt }], { fetchImpl });
    log(`[harness-pause] ${source} paused ${receipt.paused_contract_count} contract(s) ${address}`);
    return { ok: true, address, receipt };
  } catch (error) {
    log(`[harness-pause] pause failed (launch continues): ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/** Pure workflow path: the engine mounts live contracts, so no sandbox loopback is required. */
export function buildPauseFromMountedFile({ args, readFile = readFileSync, now } = {}) {
  const contractsFile = readArg(args, 'contracts-file');
  if (!contractsFile) throw new Error('--contracts-file is required');
  return computePauseReceipt({
    contracts: JSON.parse(readFile(contractsFile, 'utf8')),
    contractRef: readArg(args, 'contract-ref'),
    sessionRef: readArg(args, 'session-ref'),
    source: readArg(args, 'source') ?? 'operator-stop',
    ts: now ?? new Date().toISOString(),
  });
}

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (IS_MAIN) {
  const args = process.argv.slice(2);
  if (args.includes('--contracts-file')) {
    try { process.stdout.write(JSON.stringify(buildPauseFromMountedFile({ args }))); }
    catch (error) { console.error('[harness-pause] mounted receipt failed:', error?.message ?? error); }
    process.exit(0);
  }
  pauseOutcomeContract({ sessionRef: process.argv[2], contractRef: process.argv[3] }).catch((e) => console.error('[harness-pause] unexpected:', e?.message ?? e)).finally(() => process.exit(0));
}
