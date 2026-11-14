#!/usr/bin/env node
// packages/ai-cli-launch-adapters/do-work/continue-outcome.mjs
//
// =============================================================================
// PURPOSE: the REAL L168 outcome-continuation decision (harness-as-DATA T5)
// =============================================================================
//
// Fires on session-stop AND on clock::tick. Reads the caller's LIVE state via the
// admitted find-current-items owner op -- the outcome-continuation-contract
// records (the L168 contracts) and the recent session-events -- and writes a
// REAL continuation-decision record naming the actual open contracts + their
// current status, NOT a benign marker. If zero contracts exist, the decision
// honestly says so (L116 honest ceiling): "no open outcome-continuation
// contracts; N in-flight session(s) observed" is a REAL read, not a shim.
//
// Same self-contained by-path-leaf + admitted-ops pattern as
// emit-session-event.mjs / allocate-session.mjs (node builtins + fetch only).
// NEVER crashes the launch (best-effort; logs + exits 0).

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function nonEmpty(v) { const t = typeof v === 'string' ? v.trim() : ''; return t || null; }
function readArg(args, name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? nonEmpty(args[index + 1]) : null;
}

// self-contained target resolution (single-file mount; mirrors allocate-session.mjs)
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

/**
 * PURE: compute the real L168 continuation decision from live DATA.
 * - contracts with a non-terminal status get a "advance" instruction naming the
 *   contract + its declared next action (if the contract carries one).
 * - if none exist, the decision is an honest "no open contracts" (never a marker).
 */
export function computeChildRecovery({ childTurnStates = [], recoveryClaims = [], assignmentOutcomes = [],
  parentBindings = [] } = {}) {
  const current = new Map();
  for (const item of childTurnStates) {
    const state = item?.payload?.kind === 'codex-child-turn-state' ? item.payload : item;
    if (state?.kind !== 'codex-child-turn-state' || !nonEmpty(state.child_thread_id)
      || !nonEmpty(state.parent_thread_id) || !nonEmpty(state.agent_path)
      || !nonEmpty(state.turn_id) || !nonEmpty(state.event_ref)) continue;
    const prior = current.get(state.child_thread_id);
    if (!prior || String(state.at ?? '') > String(prior.at ?? '')) current.set(state.child_thread_id, state);
  }
  const claimed = new Set(recoveryClaims.map((item) => item?.payload ?? item)
    .filter((item) => (item?.kind === 'codex-child-recovery-claim' && item?.status === 'claimed')
      || (item?.kind === 'harness-dispatch-receipt'
        && item?.status === 'AUTHORIZED_WORK_SESSION_STARTED'
        && String(item?.dispatch_key ?? '').startsWith('codex-child-recovery:')))
    .map((item) => item.source_event_ref ?? item.dispatch_key));
  const resolved = new Set(assignmentOutcomes.map((item) => item?.payload ?? item)
    .filter((item) => item?.kind === 'codex-child-assignment-outcome'
      && ['verified-complete', 'verified-superseded'].includes(item?.status))
    .map((item) => item.source_event_ref));
  const bindings = new Map();
  for (const item of parentBindings) {
    const binding = item?.payload ?? item;
    if (binding?.kind !== 'codex-current-parent-binding'
      || binding?.status !== 'current'
      || !nonEmpty(binding.original_parent_thread_id)
      || !nonEmpty(binding.current_parent_thread_id)
      || !nonEmpty(binding.parent_assignment_ref)) continue;
    const key = binding.original_parent_thread_id;
    if (bindings.has(key)) bindings.set(key, null); // Ambiguous authority fails closed.
    else bindings.set(key, binding);
  }
  const resolveBinding = (parentThreadId, rootTurnId) => {
    const visited = new Set();
    let binding = bindings.get(parentThreadId);
    if (!binding || binding.root_turn_id !== rootTurnId) return null;
    const assignmentRef = binding.parent_assignment_ref;
    while (binding) {
      if (visited.has(binding.original_parent_thread_id)
        || binding.root_turn_id !== rootTurnId
        || binding.parent_assignment_ref !== assignmentRef) return null;
      visited.add(binding.original_parent_thread_id);
      const successor = binding.current_parent_thread_id;
      if (visited.has(successor)) return null;
      const next = bindings.get(successor);
      if (next === null) return null;
      if (!next) return { ...binding, current_parent_thread_id: successor };
      binding = next;
    }
    return null;
  };
  return [...current.values()]
    .filter((state) => state.status === 'turn_aborted' && nonEmpty(state.root_turn_id)
      && !claimed.has(state.event_ref)
      && !claimed.has(`codex-child-recovery:${state.child_thread_id}:${state.turn_id}`)
      && !resolved.has(state.event_ref)
      && resolveBinding(state.parent_thread_id, state.root_turn_id))
    .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? ''))
      || a.event_ref.localeCompare(b.event_ref))
    .map((state) => ({
      kind: 'resume-parent-assignment',
      recovery_ref: `codex-child-recovery:${state.child_thread_id}:${state.turn_id}`,
      source_event_ref: state.event_ref,
      parent_thread_id: state.parent_thread_id,
      current_parent_thread_id: resolveBinding(state.parent_thread_id, state.root_turn_id).current_parent_thread_id,
      parent_assignment_ref: resolveBinding(state.parent_thread_id, state.root_turn_id).parent_assignment_ref,
      child_thread_id: state.child_thread_id,
      root_turn_id: state.root_turn_id,
      agent_path: state.agent_path,
    }));
}

export function computeContinuation({ contracts, pauseReceipts = [], recentSessionEvents,
  childTurnStates = [], recoveryClaims = [], assignmentOutcomes = [], parentBindings = [],
  wakeSource, sessionRef = null, ts }) {
  const TERMINAL = new Set(['ACHIEVED', 'KILLED', 'SUPERSEDED']);
  const contractId = (contract) => contract?.id ?? contract?.address ?? null;
  const underlyingOpen = contracts.filter((c) => !TERMINAL.has(String(c.status || '').toUpperCase()));
  const receiptPayloads = pauseReceipts
    .map((receipt) => receipt?.payload?.kind === 'harness-stop-pause' ? receipt.payload : receipt)
    .filter((receipt) => receipt?.kind === 'harness-stop-pause');
  const receiptPausedIds = new Set(receiptPayloads.flatMap((receipt) => (
    Array.isArray(receipt.paused_contracts)
      ? receipt.paused_contracts.map((contract) => contract?.id).filter(Boolean).map(String)
      : []
  )));
  const paused = underlyingOpen.filter((contract) => (
    String(contract.status || '').toUpperCase() === 'PAUSED'
    || (contractId(contract) != null && receiptPausedIds.has(String(contractId(contract))))
  ));
  const pausedContracts = new Set(paused);
  const open = underlyingOpen.filter((contract) => !pausedContracts.has(contract));
  const inFlightSessions = new Set(recentSessionEvents.filter((e) => e.event_kind !== 'session-stop').map((e) => e.session_id)).size;
  const childRecoveryActions = computeChildRecovery({ childTurnStates, recoveryClaims, assignmentOutcomes, parentBindings });
  const decision = open.length > 0
    ? 'ADVANCE_OPEN_CONTRACTS'
    : underlyingOpen.length > 0
      ? 'PAUSED_OPEN_CONTRACTS'
      : 'NO_OPEN_CONTRACTS';
  return {
    kind: 'continuation-decision', schema: 'ai-orchestra.outcome-continuation-decision/live-v1',
    decided_at: ts, wake_source: wakeSource, session_ref: sessionRef,
    underlying_open_contract_count: underlyingOpen.length,
    paused_contract_count: paused.length,
    paused_contracts: paused.map((c) => ({ id: contractId(c), outcome: nonEmpty(c.observable_outcome) ?? null, status: c.status ?? null })),
    open_contract_count: open.length,
    open_contracts: open.map((c) => ({ id: contractId(c), outcome: nonEmpty(c.observable_outcome) ?? null, status: c.status ?? null, next_action: nonEmpty(c.next_action) ?? null })),
    in_flight_session_count: inFlightSessions,
    child_recovery_actions: childRecoveryActions,
    selected_child_recovery_action: childRecoveryActions[0] ?? null,
    decision,
    honest_note: open.length > 0
      ? `advance ${open.length} open outcome-continuation contract(s)`
      : underlyingOpen.length > 0
        ? `${paused.length} open outcome-continuation contract(s) are operator-paused; automatic continuation must not re-fire until a resume owner supersedes the pause`
        : `no open outcome-continuation contracts in this partition; ${inFlightSessions} in-flight session(s) observed (contract DATA must be authored for L168 to advance a real next action)`,
    source: 'live find-current-items over outcome-continuation-contract + harness-stop-pause + session-event',
  };
}

export async function continueOutcome(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((m) => console.error(m));
  const wakeSource = nonEmpty(options.wakeSource) ?? nonEmpty(env.BITFIELD_CONTINUE_WAKE_SOURCE) ?? 'session-stop';
  const sessionRef = nonEmpty(options.sessionRef) ?? nonEmpty(env.BITFIELD_SESSION_ID) ?? null;
  const target = options.target ?? resolveTarget(env);
  if (!target?.url) { log('[harness-continue] no engine target; skipping (launch continues)'); return { ok: false, reason: 'no-target' }; }
  try {
    const requests = await runningAppRequests();
    const session = await requests.startRunningAppSession({ url: target.url, fetchImpl });
    const payloadRows = async (inScope, where) => (await requests.findCurrentItems(session, inScope, where, { fetchImpl })).map((row) => row.payload ?? row);
    const contracts = await payloadRows('published-record', { all: [{ field: 'kind', eq: 'outcome-continuation-contract' }] });
    const pauseReceipts = await payloadRows('published-record', { all: [{ field: 'kind', eq: 'harness-stop-pause' }] });
    const events = await payloadRows('session-event', { all: [{ field: 'kind', eq: 'session-event' }] });
    const childTurnStates = await payloadRows('published-record', { all: [{ field: 'kind', eq: 'codex-child-turn-state' }] });
    const recoveryClaims = await payloadRows('published-record', { all: [{
      field: 'kind', in: ['codex-child-recovery-claim', 'harness-dispatch-receipt'],
    }] });
    const assignmentOutcomes = await payloadRows('published-record', { all: [{ field: 'kind', eq: 'codex-child-assignment-outcome' }] });
    const parentBindings = await payloadRows('published-record', { all: [{ field: 'kind', eq: 'codex-current-parent-binding' }] });
    const ts = new Date().toISOString();
    const decision = computeContinuation({ contracts, pauseReceipts, recentSessionEvents: events,
      childTurnStates, recoveryClaims, assignmentOutcomes, parentBindings, wakeSource, sessionRef, ts });
    // emit to stdout so an engine-driven compute.process step can capture + persist
    // it (captured_fds) even where the sandbox blocks the loopback self-write.
    if (options.emitStdout !== false) process.stdout.write(JSON.stringify(decision));
    // capture mode (a compute.process step captures stdout + persists it): skip the
    // self-write so the workflow-def is the single writer. standalone self-writes.
    if (nonEmpty(env.BITFIELD_HARNESS_CAPTURE_MODE)) return { ok: true, captured: true, decision };
    const address = `package::ai-cli-launch-adapters::continuation-decision::${wakeSource}::${createHash('sha256').update(ts).digest('hex').slice(0, 12)}`;
    await requests.writeRecords(session, [{ partition_label: target.partition, address_label: address, address_mode: 'identity_text', path_labels: ['current-item', 'published-record'], payload: decision }], { fetchImpl });
    log(`[harness-continue] ${wakeSource} wrote continuation decision ${address} decision=${decision.decision} open=${decision.open_contract_count}`);
    return { ok: true, address, decision };
  } catch (error) {
    log(`[harness-continue] continuation failed (launch continues): ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/** Pure workflow path: engine-native ask steps mount every live input as JSON. */
export function buildContinuationFromMountedFiles({ args, readFile = readFileSync, now } = {}) {
  const load = (name) => {
    const file = readArg(args, name);
    return file ? JSON.parse(readFile(file, 'utf8')) : [];
  };
  return computeContinuation({
    contracts: load('contracts-file'),
    pauseReceipts: load('pauses-file'),
    recentSessionEvents: load('events-file'),
    childTurnStates: load('child-states-file'),
    recoveryClaims: load('child-claims-file'),
    assignmentOutcomes: load('child-outcomes-file'),
    parentBindings: load('parent-bindings-file'),
    wakeSource: readArg(args, 'wake-source') ?? 'session-stop',
    sessionRef: readArg(args, 'session-ref'),
    ts: now ?? new Date().toISOString(),
  });
}

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (IS_MAIN) {
  const args = process.argv.slice(2);
  if (args.includes('--contracts-file')) {
    try { process.stdout.write(JSON.stringify(buildContinuationFromMountedFiles({ args }))); }
    catch (error) { console.error('[harness-continue] mounted decision failed:', error?.message ?? error); }
    process.exit(0);
  }
  continueOutcome({ wakeSource: process.argv[2] }).catch((e) => console.error('[harness-continue] unexpected:', e?.message ?? e)).finally(() => process.exit(0));
}
