#!/usr/bin/env node
// packages/ai-cli-launch-adapters/do-work/allocate-session.mjs
//
// =============================================================================
// PURPOSE: the REAL L165 allocation on session-start (harness-as-DATA T7)
// =============================================================================
//
// Reads the caller's LIVE provider/model DATA via the admitted find-current-items
// owner op, computes the real allocation (which provider/model/runtime), and
// writes a REAL allocation receipt via write-batch. This is NOT a marker: the
// receipt carries the provider/model actually selected from live log DATA, so a
// changed provider (a new is_primary row, a new runtime descriptor) changes the
// receipt with zero code change. Same self-contained by-path-leaf + admitted-ops
// pattern as emit-session-event.mjs (node builtins + fetch only, blob-safe).
//
// Invoked by the action:auto-allocate-session workflow-def (a compute.process
// step) which the session-start trigger fires; also runnable standalone to prove
// the real read+decision (BITFIELD_SESSION_ID + a reachable engine).
//
// NON-NEGOTIABLE: ZERO hardcoded provider/model. Every name is read from live
// DATA. NEVER crashes the launch (best-effort; logs + exits 0).

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


function nonEmpty(v) { const t = typeof v === 'string' ? v.trim() : ''; return t || null; }
function readArg(args, name) {
  const index = (Array.isArray(args) ? args : []).indexOf(`--${name}`);
  return index >= 0 ? nonEmpty(args[index + 1]) : null;
}

// --- target resolution (identical order to emit-session-event.mjs) ---
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

// --- context-window capability, read as DATA from ai-model-descriptor rows ---
// (#106 / L177) A harness-mounted launch mounts the whole always-loaded harness.
// If the allocated model's context window is smaller than that prompt, the launch
// overflows at runtime ("Prompt is too long"). The fitting model is selected by a
// DATA capability (context_window_tokens on ai-model-descriptor), NEVER a hardcoded
// "opus-1m" id: a bigger-context model is just a DATA row with a bigger window.
function buildContextWindowIndex(modelDescriptors) {
  const idx = new Map();
  for (const d of (Array.isArray(modelDescriptors) ? modelDescriptors : [])) {
    if (!d || typeof d !== 'object') continue;
    const raw = Number(d.context_window_tokens);
    const win = Number.isFinite(raw) && raw > 0 ? raw : null; // null/INSUFFICIENT_EVIDENCE => unknown
    const keys = [d.model_id, d.id, ...(Array.isArray(d.aliases) ? d.aliases : [])].filter((k) => typeof k === 'string' && k.trim());
    for (const k of keys) if (!idx.has(k)) idx.set(k, win);
  }
  return idx;
}
function contextWindowFor(idx, model) {
  if (typeof model !== 'string' || !model.trim()) return NaN;
  const v = idx.has(model) ? idx.get(model) : idx.get(`ai-model-descriptor:${model}`);
  return Number.isFinite(v) ? v : NaN;
}

/**
 * Resolve the exact ai-model-descriptor DATA row for a launch identity. The
 * resolver may select a CLI-local alias (`sonnet`) while provider facts carry the
 * full model id, so aliases are first-class identities. This is the one lookup
 * owner reused by dispatch fit admission; callers never duplicate their own map.
 */
export function findModelDescriptor(modelDescriptors, model) {
  const wanted = nonEmpty(model);
  if (!wanted) return null;
  const exact = [];
  const aliased = [];
  for (const descriptor of (Array.isArray(modelDescriptors) ? modelDescriptors : [])) {
    if (!descriptor || typeof descriptor !== 'object') continue;
    const keys = [descriptor.model_id, descriptor.id, ...(Array.isArray(descriptor.aliases) ? descriptor.aliases : [])]
      .filter((key) => typeof key === 'string' && key.trim());
    if (!keys.includes(wanted)) continue;
    (keys[0] === wanted ? exact : aliased).push(descriptor);
  }
  const candidates = [...exact, ...aliased];
  if (candidates.length > 1) {
    throw new Error(`ai-model-descriptor is ambiguous for ${wanted}: ${candidates.length} rows`);
  }
  return candidates[0] ?? null;
}

/**
 * PURE: compute the real allocation from live DATA rows. Selects the is_primary
 * provider (falls back to the first provider), and lists the discovered runtimes.
 * Returns a receipt payload with the REAL selection, never a hardcoded name.
 *
 * When `requiredContextTokens` is a positive number (the harness dispatch passes the
 * policy byte-budget as tokens), the selection additionally requires a model whose
 * `context_window_tokens` DATA fits. It NEVER bricks the launch (L083): if the primary
 * fits -> keep it (context_fit:'proven'); else if another model fits -> switch to the
 * largest-window fitting model (context_fit:'proven', context_reallocated_from set);
 * else if some windows are known but none fit -> best available + context_fit:'unfit';
 * else (no windows populated) -> keep primary + context_fit:'unproven' (the model-descriptor
 * DATA gap). Fields are added ONLY when a required-context is given (backward compatible).
 */
export function computeAllocation({ providerFacts, runtimeDescriptors, sessionRef, ts, modelDescriptors = [], requiredContextTokens = null }) {
  // group provider attribute_facts by subject_id
  const providers = {};
  for (const f of providerFacts) {
    const s = f.subject_id; if (typeof s !== 'string' || !s.startsWith('provider:')) continue;
    providers[s] = providers[s] || { id: s };
    const prop = String(f.property_id || '').replace('prop:provider:', '');
    let val = f.value_json; try { val = JSON.parse(f.value_json); } catch { /* keep raw */ }
    providers[s][prop] = val;
  }
  const list = Object.values(providers);
  const primary = list.find((p) => p.is_primary === true) || list[0] || null;
  const runtimes = runtimeDescriptors.map((d) => ({ id: d.id, display_name: d.display_name, deployment_class: d.deployment_class, interface: d.interface }));

  let selectedProvider = primary;
  let selectedModel = primary ? (nonEmpty(primary.model) ?? null) : null;
  let contextExtras = null;

  const req = Number.isFinite(requiredContextTokens) && requiredContextTokens > 0 ? Math.ceil(requiredContextTokens) : null;
  if (req != null) {
    const windowIdx = buildContextWindowIndex(modelDescriptors);
    const candidates = list
      .map((p) => ({ provider: p, model: nonEmpty(p.model), window: contextWindowFor(windowIdx, nonEmpty(p.model)) }))
      .filter((c) => c.model);
    const numericWindowed = candidates.filter((c) => Number.isFinite(c.window));
    const fitting = numericWindowed.filter((c) => c.window >= req);
    const selectedWindow = contextWindowFor(windowIdx, selectedModel);
    let contextFit; let reallocatedFrom = null; let chosenWindow = Number.isFinite(selectedWindow) ? selectedWindow : null;

    if (Number.isFinite(selectedWindow) && selectedWindow >= req) {
      contextFit = 'proven';
    } else if (fitting.length) {
      const best = fitting.reduce((a, b) => (b.window > a.window ? b : a));
      reallocatedFrom = selectedModel; selectedProvider = best.provider; selectedModel = best.model; chosenWindow = best.window;
      contextFit = 'proven';
    } else if (numericWindowed.length) {
      const best = numericWindowed.reduce((a, b) => (b.window > a.window ? b : a));
      if (best.model !== selectedModel) { reallocatedFrom = selectedModel; selectedProvider = best.provider; selectedModel = best.model; chosenWindow = best.window; }
      contextFit = 'unfit';
    } else {
      contextFit = 'unproven'; chosenWindow = null;
    }
    contextExtras = {
      required_context_tokens: req,
      context_fit: contextFit,
      selected_model_context_window_tokens: chosenWindow,
      ...(reallocatedFrom ? { context_reallocated_from: reallocatedFrom } : {}),
    };
  }

  return {
    kind: 'allocation-receipt', schema: 'ai-orchestra.model-allocation-outcome/live-v1', status: 'allocated',
    session_ref: sessionRef, allocated_at: ts, allocation_basis: 'session-start-trigger',
    selected_provider: selectedProvider ? selectedProvider.id : null,
    selected_vendor: selectedProvider ? (selectedProvider.vendor ?? null) : null,
    selected_model: selectedModel,
    provider_count: list.length,
    providers_considered: list.map((p) => ({ id: p.id, vendor: p.vendor ?? null, is_primary: p.is_primary === true })),
    discovered_runtimes: runtimes,
    source: 'live find-current-items over provider attribute_facts + ai-model-runtime-descriptor',
    ...(contextExtras ?? {}),
  };
}

export async function allocateSession(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((m) => console.error(m));
  const sessionRef = nonEmpty(options.sessionRef) ?? nonEmpty(env.BITFIELD_SESSION_ID) ?? `session-${Date.now()}`;
  const target = options.target ?? resolveTarget(env);
  if (!target?.url) { log('[harness-alloc] no engine target; skipping (launch continues)'); return { ok: false, reason: 'no-target' }; }
  try {
    const requests = await runningAppRequests();
    const session = await requests.startRunningAppSession({ url: target.url, fetchImpl });
    const providerFacts = (await requests.findCurrentItems(session, 'attribute_fact', { all: [{ field: 'table', eq: 'attribute_fact' }] }, { fetchImpl })).map((row) => row.payload ?? row);
    const onlyProviderFacts = providerFacts.filter((f) => typeof f.subject_id === 'string' && f.subject_id.startsWith('provider:'));
    const runtimeDescriptors = (await requests.findCurrentItems(session, 'published-record', { all: [{ field: 'kind', eq: 'ai-model-runtime-descriptor' }] }, { fetchImpl })).map((row) => row.payload ?? row);
    const ts = new Date().toISOString();
    const receipt = computeAllocation({ providerFacts: onlyProviderFacts, runtimeDescriptors, sessionRef, ts });
    // emit the computed receipt to stdout so an engine-driven compute.process step
    // can capture + persist it (captured_fds) even where the sandbox blocks the
    // loopback self-write below; standalone runs also self-write via write-batch.
    if (options.emitStdout !== false) process.stdout.write(JSON.stringify(receipt));
    // capture mode (a compute.process step captures stdout + persists it): skip the
    // self-write so the workflow-def is the single writer. standalone self-writes.
    if (nonEmpty(env.BITFIELD_HARNESS_CAPTURE_MODE)) return { ok: true, captured: true, receipt };
    const address = `package::ai-cli-launch-adapters::allocation-receipt::${sessionRef}::${createHash('sha256').update(ts).digest('hex').slice(0, 12)}`;
    await requests.writeRecords(session, [{ partition_label: target.partition, address_label: address, address_mode: 'identity_text', path_labels: ['current-item', 'published-record'], payload: receipt }], { fetchImpl });
    log(`[harness-alloc] session-start wrote allocation receipt ${address} provider=${receipt.selected_provider} runtimes=${receipt.discovered_runtimes.length}`);
    return { ok: true, address, receipt };
  } catch (error) {
    log(`[harness-alloc] allocation failed (launch continues): ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/** Pure workflow path: admitted owner steps mount live DATA, so containment needs no loopback access. */
export function buildAllocationFromMountedFiles({ args, readFile = readFileSync, now } = {}) {
  const providerFactsFile = readArg(args, 'provider-facts-file');
  const runtimeDescriptorsFile = readArg(args, 'runtime-descriptors-file');
  const sessionRef = readArg(args, 'session-ref');
  if (!providerFactsFile) throw new Error('--provider-facts-file is required');
  if (!runtimeDescriptorsFile) throw new Error('--runtime-descriptors-file is required');
  if (!sessionRef) throw new Error('--session-ref is required');
  const providerFacts = JSON.parse(readFile(providerFactsFile, 'utf8'));
  const runtimeDescriptors = JSON.parse(readFile(runtimeDescriptorsFile, 'utf8'));
  return computeAllocation({
    providerFacts,
    runtimeDescriptors,
    sessionRef,
    ts: now ?? new Date().toISOString(),
  });
}

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (IS_MAIN) {
  const args = process.argv.slice(2);
  if (args.includes('--provider-facts-file')) {
    try { process.stdout.write(JSON.stringify(buildAllocationFromMountedFiles({ args }))); }
    catch (error) {
      console.error('[harness-alloc] mounted allocation failed:', error?.message ?? error);
      process.exitCode = 1;
    }
  } else {
    allocateSession({ sessionRef: process.argv[2] }).catch((e) => console.error('[harness-alloc] unexpected:', e?.message ?? e)).finally(() => process.exit(0));
  }
}
